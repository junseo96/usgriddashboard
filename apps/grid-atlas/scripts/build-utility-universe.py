#!/usr/bin/env python3
"""Build EIA-861 reporting-entity research universe from a downloaded official ZIP.
This is a utility reporting frame, never an interconnection-project denominator.
Usage: python build-utility-universe.py --archive FILE --source FILE --index-source FILE --output FILE
Requires openpyxl. Raw archive stays outside the repository.
"""
from __future__ import annotations
import argparse,hashlib,io,json,re,zipfile
from datetime import datetime,timezone
from collections import Counter,defaultdict
from pathlib import Path
from openpyxl import load_workbook

REGIONS=['CAISO','ERCOT','ISO-NE','MISO','NYISO','PJM','SPP']
BA_REGION={'CISO':'CAISO','ERCO':'ERCOT','ISNE':'ISO-NE','MISO':'MISO','NYIS':'NYISO','PJM':'PJM','SWPP':'SPP'}
RTO_COLUMNS={14:'CAISO',15:'ERCOT',16:'PJM',17:'NYISO',18:'SPP',19:'MISO',20:'ISO-NE'}
ACTIVITY_COLUMNS={22:'generation',23:'transmission',24:'buying_transmission',25:'distribution',26:'buying_distribution',27:'wholesale_marketing',28:'retail_marketing',29:'bundled'}
MAINLAND=set('AL AZ AR CA CO CT DE DC FL GA ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split())
NONMAINLAND={'AK','HI','AS','GU','MP','PR','VI','CN'}
MISSING={'','NA','N/A','.'}

def main():
 ap=argparse.ArgumentParser();ap.add_argument('--archive','--zip',dest='archive',required=True);ap.add_argument('--source');ap.add_argument('--index-source');ap.add_argument('--generated-at');ap.add_argument('--output',required=True);a=ap.parse_args()
 raw=Path(a.archive).read_bytes();archive_hash=hashlib.sha256(raw).hexdigest()
 source=json.loads(Path(a.source).read_text()) if a.source else None
 index_source=json.loads(Path(a.index_source).read_text()) if a.index_source else None
 if source is None:
  names=zipfile.ZipFile(io.BytesIO(raw)).namelist();years=[int(m.group(1)) for n in names if (m:=re.fullmatch(r'Frame_(\d{4})\.xlsx',n))]
  if len(years)!=1:raise ValueError('Exactly one Frame year is required')
  source={'name':f'EIA Form 861 archive, metadata not supplied','url':None,'retrievedAt':None,'sha256':archive_hash,'bytes':len(raw),'dataYear':years[0],'publishedAt':None}
 if hashlib.sha256(raw).hexdigest()!=source['sha256']:raise ValueError('Archive SHA-256 mismatch')
 year=source['dataYear'];z=zipfile.ZipFile(io.BytesIO(raw));sources=([{'id':'eia861-index',**index_source}] if index_source else [])+[{'id':'eia861-archive',**source}];sheet_counts=[];excluded=[];source_notes=[]
 def book(stem):
  name=f'{stem}_{year}.xlsx';b=z.read(name);sid=stem.lower();sources.append({'id':sid,'name':name,'parentSourceId':'eia861-archive','archiveMember':name,'sha256':hashlib.sha256(b).hexdigest()})
  return sid,load_workbook(io.BytesIO(b),read_only=True,data_only=True)
 def rows(sid,s,skip):
  vals=[]
  for n,r in enumerate(s.values,1):
   if n<=skip:continue
   if r[0] is None and all(x is None for x in r):continue
   if isinstance(r[0],str) and r[0].startswith(('To calculate a state or the US total,','This data should not be added to the data in sales to ultimate customers,','These entities are one of the elements used in the state Adjustment lines','Note- Meters for','NM - Data is Not Meaningful.','Note: Data is reported as collected.','Note: Capacity reported from TPOs','Note: Data includes distributed generators')):
    source_notes.append({'sourceId':sid,'sheet':s.title,'row':n,'text':r[0]});continue
   if r[0]!=year:raise ValueError(f'Unexpected year/footer {sid}/{s.title}/{n}: {r[0]}')
   vals.append((n,r))
  sheet_counts.append({'sourceId':sid,'sheet':s.title,'dataRows':len(vals)})
  return vals
 def ev(sid,s,n):return {'sourceId':sid,'sheet':s.title,'row':n}
 sid,b=book('Frame');entities={};frame_headers=next(b['Frame'].values)
 for n,r in rows(sid,b['Frame'],1):
  if not isinstance(r[1],int) or r[1] in entities:raise ValueError('Non-unique frame utility ID')
  entities[r[1]]={'id':f'eia861:{r[1]}','utilityId':r[1],'name':r[2],'form':'861S' if r[3]=='Y' else '861','ownership':r[5],'states':set(),'utilityLocationStates':set(),'serviceStates':set(),'programStates':set(),'regions':set(),'nonIsoBaCodes':set(),'balancingAuthorityCodes':set(),'roles':set(),'serviceTypes':set(),'serviceTerritoryReported':r[19]=='X','distributionActivityReported':None,'regionAssociations':defaultdict(lambda:{'bases':set(),'states':set(),'baCodes':set(),'evidence':[]}), 'balancingAuthorityAssociations':defaultdict(lambda:{'states':set(),'bases':set(),'evidence':[]}), 'unresolvedBaEvidence':[], 'sourceEvidence':[ev(sid,b['Frame'],n)],'reportedSchedules':[frame_headers[j] for j in range(6,21) if r[j]=='X']}
 def get(sid,s,n,r):
  if r[1] not in entities:
   excluded.append({'sourceId':sid,'sheet':s.title,'row':n,'utilityId':r[1],'name':r[2],'reason':'not_a_named_frame_respondent'});return None
  e=entities[r[1]]
  if r[2]!=e['name']:e.setdefault('otherReportedNames',set()).add(r[2])
  return e
 def add_state(e,state):
  if state and state not in MAINLAND|NONMAINLAND:raise ValueError(f'Unknown state {state}')
  if state:e['states'].add(state)
 def add_region(e,region,basis,state,code,proof):
  e['regions'].add(region);a=e['regionAssociations'][region];a['bases'].add(basis)
  if state:a['states'].add(state)
  if code:a['baCodes'].add(code)
  a['evidence'].append(proof)
 def add_ba(e,code,state,basis,proof):
  if code is None or str(code).strip() in MISSING:
   e['unresolvedBaEvidence'].append({'rawBaCode':code,'state':state,**proof});return
  if code not in ba:raise ValueError(f'BA {code} not present in official BA table')
  e['balancingAuthorityCodes'].add(code);a=e['balancingAuthorityAssociations'][code];a['states'].add(state);a['bases'].add(basis);a['evidence'].append(proof)
  if code in BA_REGION:add_region(e,BA_REGION[code],basis,state,code,proof)
  else:e['nonIsoBaCodes'].add(code)
 sid,b=book('Balancing_Authority');ba={}
 for n,r in rows(sid,b.active,1):
  if r[2] not in ba:ba[r[2]]={'code':r[2],'eiaId':r[1],'name':r[4],'states':set(),'region':BA_REGION.get(r[2]),'evidence':[]}
  rec=ba[r[2]]
  if rec['name']!=r[4] or rec['eiaId']!=r[1]:raise ValueError('BA identity mismatch')
  rec['states'].add(r[3]);rec['evidence'].append(ev(sid,b.active,n))
 sid,b=book('Utility_Data')
 for s in b:
  for n,r in rows(sid,s,2):
   e=get(sid,s,n,r)
   if e is None:continue
   add_state(e,r[3]);e['utilityLocationStates'].add(r[3]);proof=ev(sid,s,n);e['sourceEvidence'].append(proof)
   for col,region in RTO_COLUMNS.items():
    if r[col]=='Y':add_region(e,region,'rto_checkbox',r[3],None,proof)
   for col,role in ACTIVITY_COLUMNS.items():
    if r[col]=='Y':e['roles'].add(role)
   if r[25]=='Y':e['distributionActivityReported']=True
   elif r[25]=='N' and e['distributionActivityReported'] is None:e['distributionActivityReported']=False
 sid,b=book('Service_Territory')
 for s in b:
  for n,r in rows(sid,s,1):
   e=get(sid,s,n,r)
   if e is None:continue
   add_state(e,r[4]);e['serviceStates'].add(r[4]);e['serviceTerritoryReported']=True
   e.setdefault('serviceTerritoryEvidence',{}).setdefault(s.title,{'sourceId':sid,'sheet':s.title,'firstRow':n,'lastRow':n,'rowCount':0})
   x=e['serviceTerritoryEvidence'][s.title];x['lastRow']=n;x['rowCount']+=1
 for stem,basis in [('Sales_Ult_Cust','sales_ba'),('Delivery_Companies','delivery_ba')]:
  sid,b=book(stem)
  for s in b:
   if s.title=='Decoupled':continue
   for n,r in rows(sid,s,3):
    e=get(sid,s,n,r)
    if e is None:continue
    add_state(e,r[6]);e['serviceStates'].add(r[6]);e['serviceTypes'].add(r[4]);proof=ev(sid,s,n);add_ba(e,r[8],r[6],basis,proof)
 sid,b=book('Short_Form')
 for s in b:
  for n,r in rows(sid,s,1):
   e=get(sid,s,n,r)
   if e is None:continue
   add_state(e,r[4]);e['serviceStates'].add(r[4]);proof=ev(sid,s,n);add_ba(e,r[5],r[4],'shortform_ba',proof)
   e['serviceTypes'].add('Bundled (861S)')
 # Additional reported-program BA schedules close assignment gaps without inferring geography.
 for stem,skip,state_col,ba_col in [('Advanced_Meters',2,5,6),('Demand_Response',3,3,4),('Dynamic_Pricing',3,4,5),('Energy_Efficiency',3,3,4)]:
  sid,b=book(stem)
  for sh in b:
   for n,r in rows(sid,sh,skip):
    e=get(sid,sh,n,r)
    if e is None:continue
    state=r[state_col];add_state(e,state);e['programStates'].add(state)
    add_ba(e,r[ba_col],state,f'{sid}_ba',ev(sid,sh,n))
 for stem,skip,allowed in [('Net_Metering',3,['States- Utility Level','Territories','TPO- State level']),('Non_Net_Metering_Distributed',2,['States_ Utility Level','Territories'])]:
  sid,b=book(stem)
  for title in allowed:
   sh=b[title]
   for n,r in rows(sid,sh,skip):
    reordered=(r[0],r[2],r[3],r[1],r[4]);e=get(sid,sh,n,reordered)
    if e is None:continue
    state=r[1];add_state(e,state);e['programStates'].add(state)
    add_ba(e,r[4],state,f'{sid}_ba',ev(sid,sh,n))
 # Sort, expose all missingness, and avoid state-based region assignment.
 for e in entities.values():
  e['mainlandStates']=sorted(e['states']&MAINLAND);outside=e['states']&NONMAINLAND
  e['geographicScope']='mixed' if e['mainlandStates'] and outside else 'mainland' if e['mainlandStates'] else 'nonmainland' if outside else 'unresolved'
  e['distributionServiceEvidence']=e['serviceTerritoryReported'] or e['distributionActivityReported'] is True or 'Delivery' in e['serviceTypes']
  e['mainlandScopeEvidence']='sales_or_service_territory' if e['serviceStates']&MAINLAND else 'program_reported_state' if e['programStates']&MAINLAND else 'utility_data_state_only' if e['mainlandStates'] else 'not_confirmed_mainland'
  e['regionAssociations']=[{'region':region,**v} for region,v in sorted(e['regionAssociations'].items())]
  e['balancingAuthorityAssociations']=[{'code':code,**v} for code,v in sorted(e['balancingAuthorityAssociations'].items())]
  e['regionAssignmentStatus']='iso_and_non_iso' if e['regions'] and e['nonIsoBaCodes'] else 'iso' if e['regions'] else 'non_iso' if e['nonIsoBaCodes'] else 'unresolved'
  e['serviceTerritoryEvidence']=list(e.get('serviceTerritoryEvidence',{}).values())
 def normal(obj):
  if isinstance(obj,set):return sorted(obj)
  if isinstance(obj,list):return [normal(x) for x in obj]
  if isinstance(obj,dict):return {k:normal(v) for k,v in obj.items()}
  return obj
 records=normal(list(sorted(entities.values(),key=lambda e:e['utilityId'])))
 mainland=[e for e in records if e['mainlandStates']]
 regions=[]
 for region in REGIONS:
  members=[e for e in mainland if region in e['regions']]
  regions.append({'region':region,'utilityIds':[e['utilityId'] for e in members],'respondentCount':len(members),'distributionServiceEvidenceCount':sum(e['distributionServiceEvidence'] for e in members),'retailMarketingActivityCount':sum('retail_marketing' in e['roles'] for e in members),'solelyCheckboxAssignedCount':sum(any(a['region']==region and a['bases']==['rto_checkbox'] for a in e['regionAssociations']) for e in members)})
 summary={'frameRespondents':len(records),'geographicScopeCounts':dict(Counter(e['geographicScope'] for e in records)),'mainlandConfirmedRespondents':len(mainland),'mainlandRegionAssignmentCounts':dict(Counter(e['regionAssignmentStatus'] for e in mainland)),'nonMainlandRespondents':sum(e['geographicScope']=='nonmainland' for e in records),'geographyUnresolvedRespondents':sum(e['geographicScope']=='unresolved' for e in records),'scheduleRows':sheet_counts,'excludedNonFrameRows':len(excluded),'excludedNonFrameIds':sorted(set(e['utilityId'] for e in excluded)),'balancingAuthorities':len(ba)}
 assert sum(summary['geographicScopeCounts'].values())==len(records)
 assert sum(summary['mainlandRegionAssignmentCounts'].values())==len(mainland)
 result={'schemaVersion':1,'datasetKind':'annual_eia861_reporting_frame','generatedAt':a.generated_at or datetime.now(timezone.utc).isoformat(),'dataYear':year,'sourcePeriod':{'start':f'{year}-01-01','end':f'{year}-12-31','basis':'annual_reporting_period'},'publishedAt':source['publishedAt'],'sources':sources,'limitations':['EIA-861/861S annual reporting-entity census; this is neither all current ISO members nor a customer interconnection-project register.','2025 annual reporting data do not assert company memberships or customer project stages in 2026.','Only exact reported BA codes or explicit Utility_Data RTO checkboxes assign ISO regions. State is used solely to filter the contiguous 48 states and DC.','Reporters can operate in more than one ISO and also non-ISO BAs. Regional counts overlap; the nationwide denominator is the deduplicated Frame utility ID.','Retail marketers, wholesalers, municipal utilities, cooperatives and transmission entities can have different roles. A reporting-entity count must never be treated as customer-project or MW coverage.','Only delivery sales, explicitly reported distribution activity or a reported equipment service territory constitute distribution-service evidence. Bundled revenue alone is insufficient: Texas retail marketers also report bundled sales. These flags are company-wide, not proof of physical service in every associated ISO.','Annual service-territory or sales membership does not supply project identifiers, requested MW, progress stages or historical bottleneck scores. All such evidence remains a separate gap.','Missing or NA BA codes and unassigned entities are retained. Withheld/Adjustment rows outside the named Frame are recorded separately; their unidentified underlying utilities cannot be recovered from these aggregate rows.','Reported states include company-location states from Utility_Data and service states from Sales, Short Form and Service Territory, and program states from reported BA schedules; each set is separate. A location-only mainland record is flagged and does not prove physical service territory. Alaska/Hawaii/territory/Canada-only reporters are retained for conservation but excluded from mainland regional counts. Unknown geography is retained as unresolved.'], 'baRegionMapping':BA_REGION,'balancingAuthorities':normal(sorted(ba.values(),key=lambda r:r['code'])),'summary':summary,'regions':regions,'utilities':records,'excludedNonFrameRows':excluded,'sourceNotes':source_notes}
 Path(a.output).write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'summary':summary,'regions':[{k:v for k,v in r.items() if k!='utilityIds'} for r in regions]},ensure_ascii=False,indent=2))
if __name__=='__main__':main()
