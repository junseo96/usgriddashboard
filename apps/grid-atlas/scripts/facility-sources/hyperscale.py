#!/usr/bin/env python3
"""Public, primary hyperscale facility inventories. No cloud-region=>site expansion.

stdlib collector; pdftotext is optional for Meta factsheets (otherwise directory
identity survives with unknown lifecycle). Old good records and evidence versions
are preserved on failure/removal. --cache-dir is a hash-checked research replay,
never a claim of a new HTTP retrieval. Default CLI always requests live sources.
"""
from __future__ import annotations
import argparse, concurrent.futures, copy, datetime as dt, hashlib, html, json, os
import re, shutil, subprocess, tempfile, unicodedata, urllib.parse, urllib.request
from pathlib import Path

STATES = {'Alabama':'AL','Arizona':'AZ','Arkansas':'AR','California':'CA','Colorado':'CO','Connecticut':'CT','Delaware':'DE','District of Columbia':'DC','Florida':'FL','Georgia':'GA','Idaho':'ID','Illinois':'IL','Indiana':'IN','Iowa':'IA','Kansas':'KS','Kentucky':'KY','Louisiana':'LA','Maine':'ME','Maryland':'MD','Massachusetts':'MA','Michigan':'MI','Minnesota':'MN','Mississippi':'MS','Missouri':'MO','Montana':'MT','Nebraska':'NE','Nevada':'NV','New Hampshire':'NH','New Jersey':'NJ','New Mexico':'NM','New York':'NY','North Carolina':'NC','North Dakota':'ND','Ohio':'OH','Oklahoma':'OK','Oregon':'OR','Pennsylvania':'PA','Rhode Island':'RI','South Carolina':'SC','South Dakota':'SD','Tennessee':'TN','Texas':'TX','Utah':'UT','Vermont':'VT','Virginia':'VA','Washington':'WA','West Virginia':'WV','Wisconsin':'WI','Wyoming':'WY'}
REGIONS={'PJM','ERCOT','MISO','CAISO','NYISO','ISO-NE','SPP','Southeast','West','Unknown'}
STATUSES={'planned','construction','operating','paused','cancelled','unknown'}
GOOGLE='https://datacenters.google/locations/'
META='https://datacenters.atmeta.com/us-locations/'
MS='https://local.microsoft.com/'
ORACLE='https://www.oracle.com/data-centers/'
CIPHER='https://cipherdigital.com/infrastructure/'
STARGATE='https://openai.com/index/five-new-stargate-sites/'
AWS_COMMUNITIES='https://www.aboutamazon.com/news/aws/amazon-data-centers-locations-news'

def now(): return dt.datetime.now(dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
def slug(s): return re.sub(r'[^a-z0-9]+','-',unicodedata.normalize('NFKD',s).encode('ascii','ignore').decode().lower()).strip('-')
def clean(s):
    s=re.sub(r'<(script|style)\b[^>]*>[\s\S]*?</\1>',' ',s,flags=re.I)
    return re.sub(r'\s+',' ',html.unescape(re.sub(r'<[^>]+>',' ',s))).strip()
def links(s): return [(html.unescape(u),clean(a)) for u,a in re.findall(r'<a\b[^>]+href=["\']([^"\']+)["\'][^>]*>([\s\S]*?)</a>',s,re.I)]
def date_published(s):
    m=re.search(r'"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})',s)
    return m[1] if m else None

def article(s):
    m=re.search(r'<h1\b[^>]*>',s)
    return clean(s[m.start():] if m else s).split('Tags:')[0]

def quote(text,needle,after=700):
    i=text.lower().find(needle.lower())
    if i<0: raise ValueError('Reviewed evidence no longer present: '+needle)
    return text[max(0,i-100):i+after]

class Collector:
    def __init__(self,state_dir,previous,cache_dir=None):
        self.state_dir=Path(state_dir);self.state_dir.mkdir(parents=True,exist_ok=True)
        (self.state_dir/'raw').mkdir(exist_ok=True)
        self.previous=previous;self.cache={};self.docs={};self.attempts=[];self.sources={s['id']:s for s in previous.get('sources',[])}
        if cache_dir:
            for p in Path(cache_dir).glob('*.meta.json'):
                m=json.loads(p.read_text())
                if m.get('path') and Path(m['path']).exists():self.cache[m['url']]=m
        self.offline=cache_dir is not None
    def fetch(self,url):
        if url in self.docs:return self.docs[url]
        stamp=now()
        try:
            if self.offline:
                m=self.cache.get(url)
                if not m:raise ValueError('No verified cached source for '+url)
                data=Path(m['path']).read_bytes()
                if hashlib.sha256(data).hexdigest()!=m['sha256']:raise ValueError('Cache hash mismatch')
                stamp=m['retrievedAt'];final=m.get('finalUrl',url)
            else:
                req=urllib.request.Request(url,headers={'User-Agent':'GridAtlas-PublicFacilityCollector/1.0'})
                with urllib.request.urlopen(req,timeout=25) as response:
                    data=response.read(32*1024*1024+1);final=response.url
                if len(data)>32*1024*1024:raise ValueError('Source exceeds 32 MiB limit')
                stamp=now()
            sha=hashlib.sha256(data).hexdigest();p=self.state_dir/'raw'/(sha+'.bin');p.write_bytes(data)
            sid='llf-hs-src-'+hashlib.sha256(url.encode()).hexdigest()[:12]+'-'+sha[:12]
            if data.startswith(b'%PDF'):
                if not shutil.which('pdftotext'):raise ValueError('Optional pdftotext unavailable for PDF; directory remains valid')
                r=subprocess.run(['pdftotext','-raw',str(p),'-'],capture_output=True,check=True,timeout=30)
                raw='';body=clean(r.stdout.decode('utf-8','replace'))
            else:
                raw=data.decode('utf-8','replace');body=clean(raw)
            if len(body)<60:raise ValueError('Empty/unparseable public document')
            doc={'id':sid,'url':url,'finalUrl':final,'raw':raw,'text':body,'sha256':sha,'retrievedAt':stamp,'publishedAt':date_published(raw),'path':str(p)}
            self.docs[url]=doc
            self.attempts.append({'id':sid,'url':url,'status':'success','checkedAt':now(),'retrievedAt':stamp,'sha256':sha,'rawPath':str(p),'replayed':self.offline})
            return doc
        except Exception as exc:
            self.attempts.append({'id':'attempt-'+hashlib.sha256(url.encode()).hexdigest()[:12],'url':url,'status':'failed','checkedAt':now(),'error':str(exc)})
            self.docs[url]=None
            return None
    def batch(self,urls):
        urls=list(dict.fromkeys(urls))
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:list(pool.map(self.fetch,urls))
    def evidence(self,doc,name,excerpt,asof=None,published=None):
        sid=doc['id']
        if sid not in self.sources:
            self.sources[sid]={'id':sid,'name':name,'url':doc['url'],'retrievedAt':doc['retrievedAt'],'sha256':doc['sha256'],'publishedAt':published or doc['publishedAt'],'excerpt':excerpt[:5500],'sourceAsOf':asof}
        elif excerpt not in self.sources[sid]['excerpt'] and len(self.sources[sid]['excerpt'])<18000:
            # A directory source keeps the individual reviewed row statements too.
            self.sources[sid]['excerpt']+='\n'+excerpt[:1800]
        return sid
    def parser_error(self,url,exc):
        self.attempts.append({'id':'parse-'+slug(url)[-100:],'url':url,'status':'failed','checkedAt':now(),'error':'Parser review: '+str(exc)})

def facility(local_id,name,operator,state,city=None,county=None,status='unknown',sources=None):
    return {'id':'LLF-HS-'+local_id,'name':name,'operator':operator,'sector':'data_center','region':'Unknown','regionBasis':'unknown','state':state,'county':county,'city':city,'lat':None,'lon':None,'identityKind':'campus','parentId':None,'lifecycle':status,'asOf':None,'sourceIds':sources or [],'capacityFacts':[],'events':[],'gridEvidence':[],'aliases':[],'legacyProjectIds':[],'notes':[]}

def event(f,date,status,sid,note,key=None):
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}',date):raise ValueError('Event requires actual precise date')
    f['events'].append({'id':f['id']+'-event-'+(key or date+'-'+status),'date':date,'status':status,'sourceIds':[sid],'note':note})

def parse_google(c):
    doc=c.fetch(GOOGLE)
    if not doc:return []
    m=re.search(r'<div id="data-centers-data"[^>]*>(.*?)</div>',doc['raw'],re.S)
    if not m:raise ValueError('Google structured locations absent')
    rows=json.loads('['+m[1]+']');us=[]
    for row in rows:
        st=next((v for k,v in STATES.items() if row['location'].endswith(', '+k)),None)
        if st:us.append((row,st))
    if len(us)<25:raise ValueError('Google US directory unexpectedly truncated')
    sid=c.evidence(doc,'Google 공식 전체 데이터센터 위치 목록','We own and operate data centers around the world; structured location / inDevelopment fields.')
    out=[]
    for row,st in us:
        location=row['location'];place=location.rsplit(', ',1)[0]
        # The South Carolina directory mixes Lowcountry marketing area with county
        # names; replace all three by the three explicit physical locations below.
        if st=='SC':continue
        f=facility('google-'+slug(location),'Google '+location,'Google',st,None if 'County' in place else place,place if 'County' in place else None,'planned' if row.get('inDevelopment') else 'operating',[sid])
        f['lat']=row.get('latitude');f['lon']=row.get('longitude')
        f['notes']=[f'공식 위치 JSON: location={location}; inDevelopment={row.get("inDevelopment")}. 개발 중 표시는 계획·공사 세부 구분을 제공하지 않습니다.','운영 표시는 캠퍼스에 운영 기능이 있음을 뜻하며 전체 증설 건물이 준공됐다는 뜻이 아닙니다. 개시일·접속 용량은 미공개입니다.']
        c.evidence(doc,'Google 공식 전체 데이터센터 위치 목록',json.dumps({k:row.get(k) for k in ['location','inDevelopment','detailPage']},ensure_ascii=False))
        if st=='TX' and place in {'Armstrong County','Pampa'}:f['notes'].append('Texas Panhandle 위치로 ERCOT 소속을 주 이름만으로 확정하지 않습니다.');f['_noGeography']=True
        out.append(f)
    sc=c.fetch(GOOGLE+'south-carolina/')
    if sc:
        text=quote(sc['text'],'locations in Moncks Corner, Summerville, and St. George',350)
        ss=c.evidence(sc,'Google South Carolina — 세 물리 시설',text+' '+quote(sc['text'],'Our three facilities',350))
        for name,county,status in [('Moncks Corner','Berkeley County','operating'),('Summerville','Dorchester County','unknown'),('St. George','Dorchester County','unknown')]:
            f=facility('google-'+slug(name+' south carolina'),'Google '+name+' campus','Google','SC',name,county,status,[sid,ss])
            f['notes']=['공식 주별 페이지가 세 물리 위치를 명시합니다. Lowcountry·군 단위 홍보 목록을 별도 시설로 중복 집계하지 않습니다.','Summerville와 St. George의 개별 운영 개시일·현재 세부 공사 단계는 이 자료만으로 구분하지 않습니다.']
            out.append(f)
    return out

def parse_meta(c):
    doc=c.fetch(META)
    if not doc:return []
    cards=re.findall(r'<article\b[^>]*>(.*?)</article>',doc['raw'],re.S)
    rows=[]
    for card in cards:
        name=re.search(r'<h3\b[^>]*class="card__title"[^>]*>(.*?)</h3>',card,re.S)
        state=re.search(r'class="card__eyebrow-text"[^>]*>(.*?)</p>',card,re.S)
        if not name or not state:continue
        st=STATES.get(clean(state[1]).title());name=clean(name[1])
        if not st:continue
        url=next((u for u,_ in links(card) if '/asset/' in u),None)
        rows.append((name,st,card,url))
    if len(rows)<20:raise ValueError('Meta US directory unexpectedly truncated')
    c.batch([u for _,_,_,u in rows if u])
    sid=c.evidence(doc,'Meta 공식 미국 데이터센터 전체 목록','Our U.S. data center fleet; individually named campus cards with state and ground-breaking year.')
    out=[]
    for name,st,card,url in rows:
        sub=c.fetch(url) if url else None
        status='unknown';ids=[sid];note=clean(card)
        if sub:
            start=sub['text'].find('The '+name+' Data Center')
            intro=sub['text'][start:start+450] if start>=0 else ''
            # Only the site-specific first paragraph supports this. The common
            # 'Our operational buildings...' boilerplate does NOT prove this site.
            if re.search(r'\bis part of our global infrastructure',intro):status='operating'
            elif 'will be part of our global infrastructure' in intro:status='construction' if re.search(r'20\s*\d\s*\d.*?break ground',note,re.I) else 'planned'
            ss=c.evidence(sub,'Meta '+name+' 공식 시설 정보지',intro+' '+quote(sub['text'],'Responsible',1000) if 'Responsible' in sub['text'] else intro)
            ids.append(ss)
        f=facility('meta-'+slug(name+' '+st),'Meta '+name+' Data Center','Meta',st,None if name in {'Richland Parish','Sarpy','Stanton Springs'} else name,name if name in {'Richland Parish','Sarpy'} else None,status,ids)
        f['notes']=[note,'정보지 첫 문장의 is part / will be part와 해당 캠퍼스 착공연도를 구분합니다. 공통 ESG 문구에 등장하는 operational buildings는 개별 준공 근거로 사용하지 않습니다.','월·연 단위 착공 정보는 임의의 일자로 시계열 사건을 만들지 않습니다. 재생에너지 프로젝트 MW는 데이터센터 수전 용량으로 넣지 않습니다.']
        if name=='Richland Parish':f['aliases']=['Hyperion'];f['legacyProjectIds']=['site:meta-hyperion-richland']
        out.append(f)
    kuna=c.fetch('https://datacenters.atmeta.com/2026/09/kuna-we-are-online/')
    if kuna:
        text=quote(kuna['text'],'is now operational',500) if 'is now operational' in kuna['text'] else quote(kuna['text'],'Data Center is online and operational',900)
        sid=c.evidence(kuna,'Meta Kuna 운영 발표',text)
        f=next(x for x in out if x['city']=='Kuna');f['lifecycle']='operating';f['sourceIds'].append(sid)
        if kuna['publishedAt']:f['asOf']=kuna['publishedAt'];event(f,kuna['publishedAt'],'operating',sid,'이 날짜의 공식 게시물에서 운영 상태를 발표했습니다. 정확한 최초 통전 시각은 아닙니다.')
    temple=c.fetch('https://datacenters.atmeta.com/2026/07/temple-we-are-online/')
    if temple:
        text=quote(temple['text'],'Data Center is now serving traffic',800)
        sid=c.evidence(temple,'Meta Temple 운영 발표',text)
        f=next(x for x in out if x['city']=='Temple');f['lifecycle']='operating';f['sourceIds'].append(sid)
        f['notes'].append('정보지의 미래형 문구보다 실제 now serving traffic 운영 발표를 우선합니다.')
        if temple['publishedAt']:f['asOf']=temple['publishedAt'];event(f,temple['publishedAt'],'operating',sid,'공식 게시물에서 now serving traffic 운영 상태를 발표했습니다.')
    return out

MS_REGIONS={'greater-phoenix':'AZ','california':'CA','greater-atlanta':'GA','illinois':'IL','indiana':'IN','greater-des-moines':'IA','michigan':'MI','nevada':'NV','north-carolina':'NC','northern-virginia':'VA','ohio':'OH','southern-virginia':'VA','greater-san-antonio':'TX','quincy':'WA','wisconsin':'WI','cheyenne':'WY'}
MS_CITY={'alviso':'Alviso','malaga':'Malaga','mount-pleasant':'Mount Pleasant','hr-ranch-road':'Cheyenne','ginger-west':None,'ginger-east':None,'tyrone':'Tyrone','palmetto':'Palmetto','east-point':'East Point','environmental-planning-update-for-proposed-wellington':None,'hansen-farm':'Manassas','jacksonville-road':'Manassas','county-road-381':'San Antonio','wiseman-boulevard':'San Antonio','westover-link':'San Antonio','lambda-drive':'San Antonio','silver-springs':'Silver Springs','microsoft-breaks-ground-on-la-porte':'La Porte','heath':'Heath','hebron':'Hebron','newalbany':'New Albany','lyle-creek':'Conover','stover':'Hickory','boyd-farms':'Maiden','person-county':None}

def parse_microsoft(c):
    home=c.fetch(MS)
    if not home:return []
    region_urls={u:MS_REGIONS.get(u.rstrip('/').split('/')[-1]) for u,label in links(home['raw']) if label.startswith('US:')}
    region_urls={u:st for u,st in region_urls.items() if st}
    c.batch(region_urls)
    projects={}
    for url,st in region_urls.items():
        d=c.fetch(url)
        if not d:continue
        for u,label in links(d['raw']):
            if '/blog/' not in u or u.split('/blog/')[1].startswith('contact-us'):continue
            if any(x in u for x in ['datacenter-construction','datacenter-project','datacenter-update','proposed-wellington','ground-on-la-porte']):projects[u]=(st,label,d)
    c.batch(projects)
    out=[]
    for url,(st,label,regional) in projects.items():
        d=c.fetch(url)
        if not d:continue
        body=article(d['raw']);key=url.rstrip('/').split('/')[-1];name=clean(re.search(r'<h1\b[^>]*>(.*?)</h1>',d['raw'],re.S)[1])
        if key=='cheyenne-datacenter-update':
            if not all(x in body for x in ['385 acre','35 acre','College Drive','Happy Jack Road']):raise ValueError('Cheyenne two-site identity changed')
            sid=c.evidence(d,'Microsoft Cheyenne 명시된 두 개발 부지',quote(body,'two additional',1000))
            for sub,loc in [('college-drive','385 acre site east of College Drive near Cheyenne Business Parkway'),('happy-jack-road','35 acre site South of Happy Jack Road near North Range Business Park')]:
                f=facility('microsoft-cheyenne-'+sub,'Microsoft Cheyenne '+sub.replace('-',' ').title(),'Microsoft','WY','Cheyenne','Laramie County','planned',[sid]);f['notes']=[loc,'주정부·시청 부지 신청은 전력 접속신청이나 계약 완료 증거가 아닙니다. 공통 Cheyenne 지역명을 제3 시설로 세지 않습니다.'];out.append(f)
            continue
        # Official opening paragraph is the project status statement. Future
        # finish dates, generic 'operations' text, and headings are not completion.
        intro=body[:900]
        status='planned' if any(x in intro.lower() for x in ['planning to','planning on','proposed wellington','has yet to commence']) else 'construction' if any(x in intro.lower() for x in ['is building','is constructing','construction','is developing']) else 'unknown'
        if key=='malaga-datacenter-project-overview':status='planned' # first paragraph is a historical future schedule, not proof it started
        sid=c.evidence(d,'Microsoft '+name,body[:5200])
        rs=c.evidence(regional,'Microsoft 공식 '+st+' 시설 지역 색인',label+' — '+url)
        city=next((v for k,v in MS_CITY.items() if key.startswith(k)),None)
        f=facility('microsoft-'+re.sub(r'-datacenter.*','',key), 'Microsoft '+name.replace(' datacenter construction update','').replace(' datacenter project overview','').replace(' datacenter project update','').replace(' datacenter update','').replace(' datacenter construction',''), 'Microsoft',st,city,'Person County' if key.startswith('person-county') else None,status,[sid,rs])
        f['name']=re.sub(r' datacenter.*$', '', 'Microsoft '+name)
        f['notes']=['최신 공개 프로젝트 페이지에 기술된 상태입니다. 오래된 목표 준공일이 지났다는 이유로 운영으로 승격하지 않습니다.','문서 메타데이터 수정일은 현장 단계 전환일로 사용하지 않습니다. 시설 공사와 외부 계통보강 공사는 구분됩니다.']
        if key.startswith('environmental-'):f['name']='Microsoft Wellington proposed campus';f['id']='LLF-HS-microsoft-wellington';f['county']='Prince William County'
        if key.startswith('microsoft-breaks-ground-on-la-porte'):
            f['id']='LLF-HS-microsoft-la-porte';f['name']='Microsoft La Porte campus';f['lifecycle']='construction';f['asOf']='2026-06-18';event(f,'2026-06-18','construction',sid,'On Thursday, June 18 [2026], Microsoft marked ... a groundbreaking event for its new datacenter project.')
        if key=='boyd-farms-datacenter-construction-update' and 'began April 1, 2024' in body:event(f,'2024-04-01','construction',sid,'Datacenter construction began April 1, 2024.')
        out.append(f)
    if len(out)<15:raise ValueError('Microsoft project page inventory unexpectedly truncated')
    return out

def parse_oracle(c):
    home=c.fetch(ORACLE)
    if not home:return []
    urls=list(dict.fromkeys(u for u,_ in links(home['raw']) if u.startswith(ORACLE) and u!=ORACLE))
    c.batch(urls)
    geo={'abilene':('TX','Abilene','Taylor County'),'shackelford-county':('TX',None,'Shackelford County'),'dona-ana-county':('NM',None,'Doña Ana County'),'port-washington':('WI','Port Washington','Ozaukee County'),'saline-township':('MI','Saline Township','Washtenaw County')}
    out=[]
    for url in urls:
        key=url.rstrip('/').split('/')[-1]
        if key not in geo:continue
        d=c.fetch(url)
        if not d:continue
        st,city,county=geo[key];body=article(d['raw'])
        status='unknown' if key=='abilene' else 'planned'  # Some AI workloads live != all eight campus buildings operational.
        sid=c.evidence(d,'Oracle '+key.replace('-',' ')+' 공식 AI 캠퍼스',body[:5000])
        f=facility('oracle-'+key,'Oracle / Stargate '+key.replace('-',' ').title(),'Oracle / OpenAI',st,city,county,status,[sid])
        f['notes']=['공식 페이지가 January 2026 기준이라고 명시하며 정확한 기준일은 없어 asOf를 비워 둡니다. 새 수집시각을 상태 기준일로 대체하지 않습니다.','채용·예상 고용·주변 발전 추가 MW는 개별 캠퍼스 수전 MW가 아닙니다.']
        if key=='abilene':f['notes'].append('원문은 AI workloads went live만 확인하고 캠퍼스가 eight buildings라고 명시합니다. 8동 전체의 운영 완료나 남은 공사 상태는 이 근거로 확인되지 않아 캠퍼스 lifecycle을 unknown으로 보존합니다.');f['region']='ERCOT';f['regionBasis']='reported';f['aliases']=['Stargate Abilene','Crusoe Abilene'];f['gridEvidence']=[{'id':f['id']+'-ercot','kind':'unknown','date':None,'sourceIds':[sid],'note':'AI workloads went live; The Abilene AI data center connects directly to the ERCOT grid. 일부 통전·운영만 확인되며 전체 8동 캠퍼스의 통전·운영 승인 완료는 미확인입니다. 전체 캠퍼스 완료 점수에 사용하지 않습니다.'}]
        if key=='shackelford-county':f['aliases']=['Vantage Frontier'];f['notes'].append('자체 엔진 기반 마이크로그리드를 명시합니다. ERCOT 고객 접속신청을 확인한 자료가 아닙니다.')
        if key=='dona-ana-county':f['aliases']=['Project Jupiter'];f['notes'].append('Bloom Energy 연료전지 마이크로그리드가 지역 전력망과 독립 운영된다고 명시합니다. 전력망 접속 신청으로 해석하지 않습니다.')
        if key=='port-washington':f['aliases']=['Vantage Lighthouse'];f['notes'].append('2,000 MW는 Wisconsin에 추가될 신재생 발전이며 이 캠퍼스 부하가 아닙니다.')
        if key=='saline-township':f['aliases']=['Green Chile Ventures','Related Saline'];f['legacyProjectIds']=['site:oracle-saline']
        out.append(f)
    sg=c.fetch(STARGATE)
    if sg:
        ss=c.evidence(sg,'OpenAI Stargate 5개 신규 부지 발표',quote(sg['text'],'One site is located in Lordstown',1200),published='2025-09-23')
        for key,st,city,county,status in [('lordstown','OH','Lordstown','Trumbull County','construction'),('milam-county','TX',None,'Milam County','planned')]:
            f=facility('stargate-'+key,'OpenAI / SoftBank Stargate '+key.replace('-',' ').title(),'OpenAI / SoftBank',st,city,county,status,[ss]);f['asOf']='2025-09-23';event(f,'2025-09-23',status,ss,'공식 발표 당시 '+('SoftBank has broken ground' if key=='lordstown' else 'will be developed in partnership with SB Energy')+'; 실제 통전일을 미래 목표일로 생성하지 않습니다.')
            f['notes']=['1.5 GW는 Lordstown+Milam 두 시설 합계로 개별 용량에 배분하지 않습니다. 과거 발표 당시 단계이며 2026년 현재 완료 확인이 아닙니다.'];out.append(f)
    return out

CIPHER_UPDATE='https://investors.cipherdigital.com/news-releases/news-release-details/cipher-digital-provides-second-quarter-2026-business-update'
CIPHER_DECK='https://investors.cipherdigital.com/static-files/58e46e77-13f9-4514-8c2a-2c7695cf2b4a'

def parse_cipher(c):
    doc=c.fetch(CIPHER)
    if not doc:return []
    rows=re.findall(r'([A-Z][A-Za-z0-9 ]+?) Capacity ([\d,.]+) MW Energization Timeline (.*?)(?= [A-Z][A-Za-z ]+ Capacity | Operating Capacity|$)',doc['text'])
    # Use the actual HTML row boundary; the broad text contains section labels.
    chunks=re.split(r'<div class="overview-accords__site-row"',doc['raw'])[1:]
    out=[];seen=set()
    update=c.fetch(CIPHER_UPDATE);deck=c.fetch(CIPHER_DECK)
    for chunk in chunks:
        title=re.search(r'class="overview-accords__site-title"[^>]*>(.*?)</span>\s*<span class="overview-accords__site-icon',chunk,re.S)
        if not title:continue
        name=clean(title[1]);text=clean(chunk).split('Pipeline Capacity')[0].split('Operating Capacity')[0]
        cap=re.search(r'Capacity ([\d,.]+) MW',text)
        if not cap or name in seen:continue
        seen.add(name)
        timeline=re.search(r'Energization Timeline (.*?)(?:$| [A-Z][A-Za-z ]+ Capacity)',text)
        sid=c.evidence(doc,'Cipher 공식 개별 캠퍼스 용량·가동 계획',text[:400])
        original=name
        if name=='Third HPC Lease':
            if not update or 'Stingray' not in update['text']:continue # no invented anonymous new site
            name='Stingray'
        st='OH' if name=='Ulysses' else 'TX' if name not in {'Milsing'} else None
        status='operating' if name=='Odessa' else 'construction' if name in {'Barber Lake','Black Pearl','Stingray'} else 'planned'
        f=facility('cipher-'+slug(name),'Cipher '+name,'Cipher Digital',st,'Odessa' if name=='Odessa' else None,None,status,[sid]);f['legacyProjectIds']=['site:pjm-cipher-ulysses' if name=='Ulysses' else 'site:cipher-'+slug(name)]
        if name.endswith(' Expansion'):
            f['identityKind']='phase';f['parentId']='LLF-HS-cipher-'+slug(name.replace(' Expansion',''))
        f['capacityFacts']=[{'id':f['id']+'-capacity','value':float(cap[1].replace(',','')),'unit':'MW','measure':'facility_power','scope':'phase' if f['identityKind']=='phase' else 'campus','asOf':None,'sourceIds':[sid],'note':'회사 표의 Site Capacity. 계통 신청 MW·실제 운영 부하·IT 부하와 동일하지 않습니다. '+text[:240]}]
        f['notes']=['Energized는 전력 설비 통전을 뜻하며 고객 서버의 전체 용량 운영으로 해석하지 않습니다. 증설은 부모 캠퍼스에 연결된 phase로 보존합니다.','표의 분기/2030+ 표시는 미래 목표이며 실제 사건 날짜로 생성하지 않습니다.']
        if deck and name in {'Ulysses','Reveille','Colchis','Mikeska','McLennan','Barber Lake','Black Pearl','Stingray','Odessa'}:
            ds=c.evidence(deck,'Cipher 2026-02-24 공식 투자자 시설 설명',quote(deck['text'],name,850),asof='2026-02-24',published='2026-02-24');f['sourceIds'].append(ds)
            if name=='Ulysses':f['region']='PJM';f['regionBasis']='reported';f['gridEvidence']=[{'id':f['id']+'-approved-interconnection','kind':'study','date':'2026-02-24','sourceIds':[ds],'note':'Recently acquired site in Ohio with approved interconnection in the PJM market for 200 gross MW.'}]
        if update and name in {'Barber Lake','Black Pearl','Stingray','Apollo'}:
            us=c.evidence(update,'Cipher 2026-08-04 공식 사업 진행 발표',quote(update['text'],name,1200),asof='2026-08-04',published='2026-08-04');f['sourceIds'].append(us);f['asOf']='2026-08-04'
            event(f,'2026-08-04',status,us,'해당 날짜 사업보고가 명시한 진행 상태. 일부 고객 인도·부지 공사와 전체 캠퍼스 운영을 구분합니다.')
        if original!=name:f['aliases'].append(original)
        out.append(f)
    actual_ids={f['id'] for f in out}
    out=[f for f in out if not f['parentId'] or f['parentId'] in actual_ids]
    if len(out)<8:raise ValueError('Cipher site table unexpectedly truncated')
    return out

AWS_PA='https://www.aboutamazon.com/news/aws/amazon-pennsylvania-investment-cloud-infrastructure-ai-innovation'
AWS_IN='https://www.aboutamazon.com/news/aws/aws-indiana-investment-11-billion'
AWS_MS='https://www.aboutamazon.com/news/company-news/amazon-25-billion-mississippi-data-centers'
AWS_LA='https://www.aboutamazon.com/news/company-news/amazon-data-center-louisiana-new-jobs'
TVA_XAI='https://tva-azr-eastus-cdn-ep-tvawcm-prd.azureedge.net/cdn-tvawcma/docs/default-source/about-tva/board-of-directors/november--7-2024/resolutions/reading-room-11072024g-grtr-100mw-ctc-xai-reso-memo.pdf?sfvrsn=55653613_1'
CORE_LANCASTER='https://chirisatechnologyparks.com/blue-owl-and-chirisa-technology-parks-close-4-billion-joint-venture-partnership-including-machine-investment-group-for-lancaster-campus/'

def parse_other(c):
    urls=[AWS_PA,AWS_IN,AWS_MS,AWS_LA,AWS_COMMUNITIES,TVA_XAI,CORE_LANCASTER,'https://x.ai/colossus']
    c.batch(urls);out=[]
    # Explicit single campus/converted plant only. Statewide investments and
    # multiple unidentified campuses are NOT expanded into invented site rows.
    specs=[
      (AWS_PA,'aws-salem','AWS Salem Township campus','PA','Salem Township','Luzerne County','planned','Salem Township','2025-06-09'),
      (AWS_PA,'aws-falls','AWS Falls Township campus','PA','Falls Township','Bucks County','planned','Falls Township','2025-06-09'),
      (AWS_IN,'aws-new-carlisle','AWS Indiana Enterprise Center campus','IN','New Carlisle','St. Joseph County','planned','This new data center campus','2024-04-25'),
      (AWS_MS,'aws-canton','AWS Canton campus','MS','Canton','Madison County','unknown',"Amazon’s facility in Canton",None),
      (AWS_MS,'aws-clinton-delphi','AWS Clinton former Delphi plant','MS','Clinton','Hinds County','construction','transforming the former Delphi',None),
      (AWS_LA,'aws-shreveport-third','AWS third Shreveport campus','LA','Shreveport','Caddo Parish','planned','a third planned campus in Shreveport',None),
      (AWS_COMMUNITIES,'aws-richmond-county','AWS Richmond County campus','NC',None,'Richmond County','construction','Amazon is building a new data center campus in Richmond County','2026-09-23'),
    ]
    for url,key,name,st,city,county,status,marker,date in specs:
        d=c.fetch(url)
        if not d:continue
        try:q=quote(d['text'],marker,1400)
        except ValueError as ex:c.parser_error(url,ex);continue
        sid=c.evidence(d,'Amazon 공식 시설·개발 발표',q)
        f=facility(key,name,'Amazon Web Services',st,city,county,status,[sid]);f['asOf']=date
        f['notes']=['회사 전체 투자액·발전 PPA·여러 캠퍼스 합계는 개별 수전 용량으로 배분하지 않습니다. 동일 지역에 있는 시설을 임의로 추가 분할하지 않습니다.']
        if date:event(f,date,status,sid,'이 날짜의 공식 공시에서 확인된 상태이며 계획된 완공 날짜가 아닙니다.')
        if key=='aws-shreveport-third':f['notes'].append('추가 발표가 명시한 세 번째 캠퍼스만 개별화했습니다. 처음 두 Caddo/Bossier 캠퍼스는 개별 부지 식별이 완료되지 않아 임의 두 행으로 만들지 않았습니다.');f['aliases']=['STACK Shreveport third campus']
        if key=='aws-canton':f['notes'].append('Canton 시설 실재·냉각 전환계획은 확인되나 운영/공사 경계가 명확하지 않아 unknown입니다.')
        if key=='aws-clinton-delphi':f['notes'].append('2026-06-09 기사 내 ribbon-cutting이 전체 데이터센터 가동을 뜻하는지 미확인으로 운영 승격하지 않습니다.')
        if key=='aws-salem':f['legacyProjectIds']=['site:pjm-amazon-salem-township-pa']
        if key=='aws-falls':f['legacyProjectIds']=['site:pjm-amazon-falls-township-pa']
        out.append(f)
    x=c.fetch(TVA_XAI)
    if x:
        ss=c.evidence(x,'TVA xAI Memphis 전력 공급 승인',' '.join([quote(x['text'],'150 MW',800),quote(x['text'],'By August',700)]),asof='2024-11-07',published='2024-11-07')
        f=facility('xai-colossus-memphis','xAI Colossus — former Electrolux Memphis','xAI','TN','Memphis','Shelby County','operating',[ss]);f['region']='Southeast';f['regionBasis']='reported';f['asOf']='2024-11-07';f['aliases']=['CTC Property LLC'];f['legacyProjectIds']=['TVA::11-07-24G::CTC-xAI-Memphis']
        f['capacityFacts']=[{'id':f['id']+'-tva-150','value':150,'unit':'MW','measure':'contracted_grid','scope':'phase','asOf':'2024-11-07','sourceIds':[ss],'note':'150 MW 조건부 확정공급 승인. 실제 전력 소비나 Colossus 전체 증설 용량이 아닙니다.'}]
        f['gridEvidence']=[{'id':f['id']+'-tva','kind':'contract','date':'2024-11-07','sourceIds':[ss],'note':'TVA approves 150 MW power supply contingent on demand-response terms.'}]
        event(f,'2024-11-07','operating',ss,'승인 문서가 2024년 8월 이미 일부 MLGW 전력과 자체 가스터빈을 함께 사용해 운영했다고 명시합니다. 11월7일은 공시 기준일입니다.')
        d=c.fetch('https://x.ai/colossus')
        if d:f['sourceIds'].append(c.evidence(d,'xAI 공식 Colossus 시설 소개',quote(d['text'],'Built in 122 days',900)))
        f['notes']=['Colossus 2·Southaven을 이 Memphis 초기 캠퍼스의 용량이나 진행 사건으로 합치지 않습니다.'];out.append(f)
    d=c.fetch(CORE_LANCASTER)
    if d:
        sid=c.evidence(d,'Chirisa / CoreWeave Lancaster 공식 개발 공시',quote(d['text'],'Lancaster',1800),asof='2025-08-25',published='2025-08-25')
        f=facility('coreweave-lancaster','CoreWeave / Chirisa Lancaster campus','CoreWeave / Chirisa','PA','Lancaster',None,'construction',[sid]);f['asOf']='2025-08-25';f['aliases']=['Chirisa LPE-01'];f['legacyProjectIds']=['site:pjm-coreweave-lancaster'];f['notes']=['CoreWeave의 51개 데이터센터/회사 GW를 51개의 익명 시설이나 이 시설 용량으로 만들지 않습니다. 개발사 Chirisa와 고객 CoreWeave의 동일 캠퍼스입니다.'];event(f,'2025-08-25','construction',sid,'공식 개발·임대 공시 당시 공사 상태. 이후 전체 운영 여부는 별도 확인이 필요합니다.');out.append(f)
    return out

def merge_previous(previous,current):
    """No missing-page deletion; union immutable old events and evidence IDs."""
    old={f['id']:copy.deepcopy(f) for f in previous.get('facilities',[])}
    for f in current:
        prior=old.get(f['id'])
        if prior:
            # Prior dated evidence remains queryable; current lifecycle is the
            # newest successful parser's actual statement, not fetch chronology.
            for field in ['events','capacityFacts','gridEvidence']:
                merged={x['id']:x for x in prior.get(field,[])}
                merged.update({x['id']:x for x in f[field]});f[field]=list(merged.values())
            f['sourceIds']=list(dict.fromkeys(prior['sourceIds']+f['sourceIds']))
        old[f['id']]=f
    return list(old.values())

def validate(fragment):
    sources={s['id']:s for s in fragment['sources']}
    if len(sources)!=len(fragment['sources']):raise ValueError('Duplicate source IDs')
    ids=set()
    for s in sources.values():
        if not re.fullmatch('[0-9a-f]{64}',s['sha256']):raise ValueError('Bad source hash')
        if not s['retrievedAt'].endswith('Z'):raise ValueError('Non UTC source time')
    for f in fragment['facilities']:
        if f['id'] in ids:raise ValueError('Duplicate facility ID')
        ids.add(f['id'])
        if f['lifecycle'] not in STATUSES or f['region'] not in REGIONS:raise ValueError('Invalid enum')
        for group in [f]+f['capacityFacts']+f['events']+f['gridEvidence']:
            if any(s not in sources for s in group['sourceIds']):raise ValueError('Unresolved evidence source')
        for e in f['events']:
            if e['date']>dt.date.today().isoformat():raise ValueError('Future event is not observed')
    for f in fragment['facilities']:
        if f['parentId'] and f['parentId'] not in ids:raise ValueError('Missing parent facility')

def collect(output,state_dir,cache_dir=None):
    output=Path(output);previous=json.loads(output.read_text()) if output.exists() else {'sources':[],'facilities':[]}
    c=Collector(state_dir,previous,cache_dir);records=[];parsers=[]
    # Independent operator groups are isolated: one changed directory cannot erase
    # the successful inventories of the other operators.
    for name,parser in [('google',parse_google),('meta',parse_meta),('microsoft',parse_microsoft),('oracle',parse_oracle),('cipher',parse_cipher),('other',parse_other)]:
        try:
            rows=parser(c)
            if not rows:raise ValueError('No successfully parsed facilities')
            records.extend(rows);parsers.append({'id':name,'status':'success','facilities':len(rows)})
        except Exception as ex:
            parsers.append({'id':name,'status':'failed','error':str(ex)});c.parser_error(name,ex)
    from geography import apply_geography
    for f in records:
        if not f.pop('_noGeography',False):apply_geography(f)
    facilities=merge_previous(previous,records)
    # legacyProjectIds are drill-down IDs in the strict project register, never
    # census entity IDs. Resolve only exact reviewed identities (no fuzzy names).
    census_path=Path(__file__).resolve().parents[2]/'data'/'load-project-census.json'
    entities=json.loads(census_path.read_text()).get('entities',[]) if census_path.exists() else []
    crosswalk={e['id']:e.get('scoreProjectId') for e in entities}
    core_ids={e.get('scoreProjectId') for e in entities if e.get('scoreProjectId')}
    for f in facilities:
        mapped=[]
        for legacy in f['legacyProjectIds']:
            core=crosswalk.get(legacy) or (legacy if legacy in core_ids else None)
            if core:mapped.append(core)
            elif legacy.startswith(('site:','request:')):
                note='기존 조사 원장 식별자: '+legacy+' (개별 점수 원장 ID 연결 미확인)'
                if note not in f['notes']:f['notes'].append(note)
        f['legacyProjectIds']=list(dict.fromkeys(mapped))
    result={'schemaVersion':1,'id':'hyperscale','generatedAt':now(),'sources':list(c.sources.values()),'facilities':sorted(facilities,key=lambda f:f['id']),'limitations':['기업 공식 개별 캠퍼스·시설 목록의 공개 범위입니다. 전국 데이터센터 전수·모든 고객 접속신청을 확보했다는 뜻이 아닙니다.','리전·도시권·회사 GW·전체 투자금은 개별 물리 시설/부하로 변환하지 않습니다. 단일 물리 시설은 여러 건물·단계를 포함할 수 있습니다.','날짜 없는 현행 목록과 실제 날짜가 있는 발표 사건을 분리합니다. 수집일은 착공일·운영 개시일이 아닙니다.','현재 단계는 마지막 공개 근거 상태입니다. 오래된 목표 일정 경과로 자동 준공·운영을 추정하지 않습니다.','성공 원문의 변경·누락 또는 수집 실패로 기존 시설·이력을 삭제하지 않습니다. 차기 철회·취소는 명시적 근거로만 반영합니다.','다른 개발사·임차인 목록과 같은 캠퍼스가 중복될 수 있어 aliases와 legacyProjectIds를 보존하며 전체 통합 단계에서 검토합니다.']}
    failures=[a for a in c.attempts if a['status']=='failed'];status='failed' if not records else 'partial' if failures else 'success'
    report={'id':'hyperscale','startedWithFacilities':len(previous.get('facilities',[])),'generatedAt':now(),'status':status,'sources':c.attempts,'parsers':parsers,'facilityCount':len(facilities),'refreshedFacilities':len(records),'preservedFacilities':len(facilities)-len(records)}
    if records:
        try: validate(result)
        except Exception as exc:
            report['status']='failed';report['validationError']=str(exc)
            (Path(state_dir)/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
            return 1
        output.parent.mkdir(parents=True,exist_ok=True)
        tmp=output.with_suffix('.tmp');tmp.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');os.replace(tmp,output)
    (Path(state_dir)/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({k:v for k,v in report.items() if k!='sources'},ensure_ascii=False))
    return 1 if status=='failed' else 0

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--output',required=True);p.add_argument('--state-dir',required=True);p.add_argument('--cache-dir',help='Optional hash-verified local research replay; no new retrieval timestamp')
    a=p.parse_args();raise SystemExit(collect(a.output,a.state_dir,a.cache_dir))
