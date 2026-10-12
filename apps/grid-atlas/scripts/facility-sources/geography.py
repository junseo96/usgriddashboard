"""Broad geographic market labels for exploration, never proof of serving utility.

State/metro approximations are explicit. A serving utility, BA boundary or project
interconnection record is required to establish actual regulatory jurisdiction.
Unknown border territories stay Unknown. These labels cannot prove tariff scope.
"""
import re
REGION_NOTE = '권역은 주·도시를 이용한 지리상 추정입니다. 실제 공급 유틸리티·접속 ISO·규제 관할의 확정 근거가 아닙니다.'
STATE_REGIONS = {
 'CT':'ISO-NE','MA':'ISO-NE','ME':'ISO-NE','NH':'ISO-NE','RI':'ISO-NE','VT':'ISO-NE',
 'NY':'NYISO','NJ':'PJM','DE':'PJM','MD':'PJM','PA':'PJM','OH':'PJM','VA':'PJM','WV':'PJM','DC':'PJM',
 'MI':'MISO','WI':'MISO','MN':'MISO','IA':'MISO','AR':'MISO','LA':'MISO',
 'KS':'SPP','OK':'SPP','NE':'SPP',
 'AL':'Southeast','FL':'Southeast','GA':'Southeast','NC':'Southeast','SC':'Southeast','TN':'Southeast',
 'AZ':'West','CO':'West','ID':'West','MT':'West','NM':'West','NV':'West','OR':'West','UT':'West','WA':'West','WY':'West',
 'CA':'CAISO','TX':'ERCOT',
}
METROS = {
 'CA': {'los angeles':'West','burbank':'West','glendale':'West','sacramento':'West','rancho cordova':'West','roseville':'West','modesto':'West','turlock':'West'},
 'TX': {'el paso':'West','amarillo':'SPP','texarkana':'SPP','beaumont':'MISO','port arthur':'MISO'},
 'IL': {'chicago':'PJM','elk grove village':'PJM','aurora':'PJM','franklin park':'PJM','des plaines':'PJM','itasca':'PJM','wood dale':'PJM','northlake':'PJM','hoffman estates':'PJM','dekalb':'PJM','rochelle':'PJM','rockford':'PJM','champaign':'MISO','peoria':'MISO','springfield':'MISO'},
 'IN': {'indianapolis':'MISO','plainfield':'MISO','new albany':'MISO','hammond':'MISO','lebanon':'MISO','fort wayne':'PJM','south bend':'PJM','new carlisle':'PJM'},
 'MO': {'st louis':'MISO','saint louis':'MISO','kansas city':'SPP','springfield':'SPP'},
 'KY': {'louisville':'Southeast','lexington':'Southeast','ashland':'PJM','owensboro':'MISO'},
 'MS': {'jackson':'MISO','madison':'MISO','canton':'MISO','vicksburg':'MISO','tupelo':'Southeast','southaven':'Southeast'},
 'LA': {'shreveport':'SPP','bossier city':'SPP'},
 'AR': {'bentonville':'SPP','fayetteville':'SPP','springdale':'SPP'},
 'MI': {'benton harbor':'PJM','st joseph':'PJM'},
}
def assign_region(state, city=None, county=None, lat=None, lon=None):
    """Return (region, basis, note); no silently reported/exact geography."""
    state=(state or '').upper().strip()
    city=re.sub(r'[^a-z0-9 ]','',str(city or '').lower()).strip()
    region=METROS.get(state,{}).get(city) or STATE_REGIONS.get(state,'Unknown')
    return region, 'geographic_estimate' if region!='Unknown' else 'unknown', REGION_NOTE if region!='Unknown' else '복수 계통권역이 있는 주에서 공급 유틸리티·위치 근거가 부족해 권역을 미확인으로 보존합니다.'

def apply_geography(facility):
    """Only fill unknown labels; preserve a parser's explicitly evidenced region."""
    if facility.get('region') not in (None,'','Unknown'):return facility
    region,basis,note=assign_region(facility.get('state'),facility.get('city'),facility.get('county'),facility.get('lat'),facility.get('lon'))
    facility['region']=region;facility['regionBasis']=basis
    if note not in facility.setdefault('notes',[]):facility['notes'].append(note)
    return facility
