import json,os,re,sys,urllib.request,urllib.parse
cfg=open(os.path.expanduser('~/.runpod/config.toml')).read()
KEY=re.search(r"apikey\s*=\s*['\"]?([^'\"\s]+)['\"]?",cfg).group(1)
def gql(query,variables=None):
    url="https://api.runpod.io/graphql?api_key="+urllib.parse.quote(KEY)
    req=urllib.request.Request(url,data=json.dumps({"query":query,"variables":variables or {}}).encode(),
        headers={"content-type":"application/json","user-agent":"Mozilla/5.0 prime-agent-eray-deploy"})
    try: return json.load(urllib.request.urlopen(req,timeout=90))
    except urllib.error.HTTPError as e: return {"http":e.code,"body":e.read().decode()[:1200]}
if __name__=="__main__" and len(sys.argv)==1:
    print(json.dumps(gql('{ myself { id clientBalance } }'))[:200])

# ---------------------------------------------------------------------------------------------
# Usage:
#   python3 deploy/runpod-deploy.py                       # auth probe
#   python3 deploy/runpod-deploy.py deploy <env.json>     # create the cpu3g-4-16 pod from ENV json
#   python3 deploy/runpod-deploy.py pod <podId>           # show status + port mappings
# The env json is {"PRIME_OBSERVER_TOKEN": "...", "NANO_GPT_API_KEY": "...", ...} (never commit it).
def deploy(env_path, instance=None, volume=None, template=None, dc=None,
           image=None, registry=None, name=None):
    # Defaults target the current stack; override any of them with the matching RUNPOD_* env var
    # so a redeploy onto a new volume/image needs no edit here.
    instance = instance or os.environ.get("RUNPOD_INSTANCE", "cpu3g-4-16")
    volume   = volume   or os.environ.get("RUNPOD_VOLUME",   "o6kytzktj0")
    template = template or os.environ.get("RUNPOD_TEMPLATE", "mmv355evu2")
    dc       = dc       or os.environ.get("RUNPOD_DC",       "EU-RO-1")
    image    = image    or os.environ.get("RUNPOD_IMAGE",    "ghcr.io/erikcik/prime-agent-eray:0.1.2")
    registry = registry or os.environ.get("RUNPOD_REGISTRY", "cmtgfealr000h6h832efsrbit")
    name     = name     or os.environ.get("RUNPOD_NAME",     "prime-agent-eray")
    env=json.load(open(env_path))
    inp={"name":name,"instanceId":instance,"imageName":image,"containerRegistryAuthId":registry,
         "cloudType":"SECURE","dataCenterId":dc,"networkVolumeId":volume,"volumeMountPath":"/workspace","containerDiskInGb":40,
         "ports":"8790/http,22/tcp","env":[{"key":k,"value":v} for k,v in env.items()]}
    # templateId is optional: with RUNPOD_TEMPLATE="" the image/env/ports above are the whole spec,
    # which keeps pod secrets out of a stored template. A stale template pins its own (older) image.
    if template:
        inp["templateId"]=template
    return gql('mutation($input: deployCpuPodInput!) { deployCpuPod(input: $input) { id name desiredStatus machineId costPerHr } }',{"input":inp})

def pod(pod_id):
    return gql('query($id: String!) { pod(input:{podId:$id}) { id name desiredStatus costPerHr runtime { uptimeInSeconds ports { ip isIpPublic privatePort publicPort type } } } }',{"id":pod_id})

if __name__=="__main__" and len(sys.argv)>1:
    if sys.argv[1]=="deploy": print(json.dumps(deploy(sys.argv[2]),indent=1))
    elif sys.argv[1]=="pod": print(json.dumps(pod(sys.argv[2]),indent=1))
