"""
The explainer kit's files as the backend reads them: the icon names and their search words, and the logo
library's index (frontend/public/assets/motion/kit, written by frontend/scripts/build-kit-icons.mjs). Claude's
find_icons searches them, and a scene that names an icon or logo the kit doesn't have is told so when it is
written (the page would show an error box instead).
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path

KIT_DIR = Path(__file__).resolve().parent.parent.parent / "frontend" / "public" / "assets" / "motion" / "kit"

ICON_RE = re.compile(r"""data-icon\s*=\s*["']([^"'{}]+)["']""")
LOGO_RE = re.compile(r"""data-logo\s*=\s*["']([^"'{}]+)["']""")


@lru_cache(maxsize=1)
def icon_tags() -> dict[str, list[str]]:
    """{icon name: its search words}; empty when the kit's files are missing (an old checkout)."""
    f = KIT_DIR / "icons" / "tags.json"
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}


@lru_cache(maxsize=1)
def logo_index() -> dict[str, str]:
    """{"aws/s3": its name, ...}; empty when the kit's files are missing."""
    f = KIT_DIR / "logos" / "index.json"
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}


# what people call the services in the logo library, so "database" finds aws/rds and "queue" finds aws/sqs
LOGO_WORDS = {
    "aws/rds": "database sql relational", "aws/aurora": "database sql relational", "aws/dynamodb": "database nosql key value",
    "aws/s3": "storage object bucket files", "aws/bucket": "storage object bucket files", "aws/ebs": "disk storage volume",
    "aws/efs": "file storage shared", "aws/sqs": "queue message", "aws/sns": "notification pubsub topic message",
    "aws/eventbridge": "event bus events", "aws/elasticache": "cache redis memcached", "aws/lambda": "function serverless",
    "aws/ec2": "server virtual machine vm compute", "aws/ecs": "containers docker", "aws/eks": "kubernetes containers",
    "aws/fargate": "containers serverless", "aws/ecr": "container registry images", "aws/cloudfront": "cdn edge cache",
    "aws/route53": "dns domain", "aws/apigateway": "api gateway", "aws/elb": "load balancer", "aws/alb": "load balancer http",
    "aws/nlb": "load balancer tcp network", "aws/vpc": "network private", "aws/nat": "nat gateway network",
    "aws/iam": "identity access permissions", "aws/cloudwatch": "monitoring logs metrics", "aws/xray": "tracing",
    "aws/waf": "firewall security", "aws/shield": "ddos security", "aws/secrets": "secrets passwords",
    "aws/bedrock": "ai llm models generative", "aws/sagemaker": "machine learning ml training", "aws/stepfunctions": "workflow orchestration",
    "azure/sqldb": "database sql", "azure/cosmos": "database nosql", "azure/storage": "storage blob files",
    "azure/servicebus": "queue message", "azure/eventhubs": "stream events", "azure/eventgrid": "events pubsub",
    "azure/redis": "cache", "azure/vm": "server virtual machine compute", "azure/aks": "kubernetes containers",
    "azure/functions": "function serverless", "azure/frontdoor": "cdn edge load balancer", "azure/appgw": "load balancer gateway",
    "azure/apim": "api gateway management", "azure/dns": "dns domain", "azure/keyvault": "secrets keys",
    "azure/foundry": "ai llm models", "azure/monitor": "monitoring metrics", "azure/loganalytics": "logs",
    "brands/postgres": "database sql", "brands/mysql": "database sql", "brands/redis": "cache key value",
    "brands/kafka": "stream queue events message", "brands/rabbitmq": "queue message", "brands/nginx": "web server proxy load balancer",
    "brands/haproxy": "load balancer proxy", "brands/docker": "containers", "brands/kubernetes": "containers orchestration",
    "brands/prometheus": "monitoring metrics", "brands/grafana": "dashboards monitoring", "brands/github": "git code repository",
    "brands/git": "version control", "brands/opensearch": "search", "brands/jaeger": "tracing", "brands/otel": "tracing telemetry",
}


# the same for the icons a system design or AI diagram reaches for most (Lucide's own tags miss these words)
ICON_WORDS = {
    "split": "load balancer router fan out", "network": "load balancer topology cluster", "server": "backend host machine node",
    "list-ordered": "queue fifo jobs", "rows-3": "queue buffer", "database-zap": "cache redis", "zap": "cache fast",
    "brain": "ai llm model neural", "bot": "ai llm assistant chatbot agent", "sparkles": "ai generative llm",
    "cpu": "compute gpu processor", "memory-stick": "ram memory", "hard-drive": "disk storage", "timer": "latency timeout",
    "gauge": "throughput performance load", "shield-check": "security auth", "key-round": "api key auth token",
    "boxes": "microservices services containers", "container": "docker container", "globe": "internet web dns cdn",
    "radio-tower": "broadcast pubsub", "webhook": "webhook events callback", "workflow": "pipeline orchestration",
    "lock": "encryption tls security", "file-json": "json payload response", "arrow-left-right": "request response",
}


def _score(words: list[str], name: str, extra: list[str]) -> int:
    """How well a name (and its tags or label) answers the search words: a whole-name match first, then a
    word of the name, then a tag; every word must be found somewhere."""
    parts = set(re.split(r"[-/ ]", name.lower()))
    tags = " ".join(extra).lower()
    total, matched = 0, 0
    for w in words:
        if name.lower() == w or name.lower().endswith("/" + w):
            total += 100
        elif w in parts:
            total += 40
        elif w in name.lower():
            total += 20
        elif re.search(r"\b" + re.escape(w), tags):
            total += 10
        else:
            continue
        matched += 1
    # names that answer every word rank above those that answer some
    return matched * 1000 + total if matched else 0


def find_icons(query: str, limit: int = 30) -> dict:
    """The icons and logos that match the search words, best first: {icons: [(name, tags)], logos: [(name,
    label)]}. An empty search lists the logo library and a starter set of icons for tech diagrams."""
    words = [w for w in re.split(r"[\s,]+", (query or "").lower()) if w]
    tags, logos = icon_tags(), logo_index()
    if not words:
        starter = ["smartphone", "laptop", "monitor", "server", "database", "hard-drive", "cloud", "globe", "network", "router", "split", "layers", "boxes", "container", "cpu", "memory-stick", "zap", "timer", "lock", "key", "shield-check", "user", "users", "mail", "message-square", "bell", "list-ordered", "git-branch", "terminal", "code", "bug", "brain", "bot", "sparkles", "file-text", "search", "filter", "chart-line", "gauge", "activity"]
        return {"icons": [(n, tags.get(n, [])[:6]) for n in starter if n in tags], "logos": sorted(logos.items())}
    icons = sorted(((s, n) for n in tags if (s := _score(words, n, tags[n] + [ICON_WORDS.get(n, "")]))), key=lambda x: (-x[0], x[1]))
    found_logos = sorted(((s, n) for n, label in logos.items() if (s := _score(words, n, [label, LOGO_WORDS.get(n, "")]))), key=lambda x: (-x[0], x[1]))
    return {
        "icons": [(n, tags[n][:6]) for _, n in icons[:limit]],
        "logos": [(n, logos[n]) for _, n in found_logos[:limit]],
    }


def unknown_names(source: str) -> list[str]:
    """Warnings for the icons and logos a scene names that the kit doesn't have (none when the kit's files are
    missing, so an old checkout never refuses a scene)."""
    out = []
    tags, logos = icon_tags(), logo_index()
    if tags:
        bad = sorted({n.strip() for n in ICON_RE.findall(source)} - set(tags))
        if bad:
            out.append("No icon named " + ", ".join(f'"{b}"' for b in bad) + ": find_icons searches the 1,539 icons by name and meaning.")
    if logos:
        bad = sorted({n.strip() for n in LOGO_RE.findall(source)} - set(logos))
        if bad:
            out.append("No logo " + ", ".join(f'"{b}"' for b in bad) + " in the library: find_icons lists them (like aws/s3, azure/aks, brands/redis). A product not in it is named in words.")
    m = cast_manifest()
    people = m.get("people", {})
    if people:
        poses, faces = set(m.get("poses", [])), set(m.get("faces", []))
        poses |= set((m.get("aliases") or {}).get("poses", {}))
        faces |= set((m.get("aliases") or {}).get("faces", {}))
        for hit in PERSON_RE.finditer(source):
            tag = hit.group(0)
            pid = hit.group(1).strip()
            p = people.get(pid)
            if not p:
                out.append(f'No person "{pid}" in the cast: the people are {", ".join(people)}.')
                continue
            pose = re.search(r"""data-pose\s*=\s*["']([^"'{}]+)["']""", tag)
            face = re.search(r"""data-face\s*=\s*["']([^"'{}]+)["']""", tag)
            if pose and pose.group(1) not in poses:
                out.append(f'{p["label"]} has no pose "{pose.group(1)}": {", ".join(m["poses"])}.')
            if face and face.group(1) not in faces:
                out.append(f'{p["label"]} has no face "{face.group(1)}": {", ".join(m["faces"])}.')
    return out


# ── the cast (frontend/public/assets/motion/kit/cast/cast.json; the player's rig draws them) ──

PERSON_RE = re.compile(r"""<[^>]*\bdata-person\s*=\s*["']([^"'{}]+)["'][^>]*>""")


@lru_cache(maxsize=1)
def cast_manifest() -> dict:
    """{poses, faces, aliases, people: {id: {label, desc, spec}}}; empty when the kit's files are missing."""
    f = KIT_DIR / "cast" / "cast.json"
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}


def cast_people() -> dict[str, dict]:
    """{id: {label, desc, spec}}."""
    return cast_manifest().get("people", {})


def cast_list() -> str:
    """The cast as the system prompt lists it: who each person is, then the poses and faces they all share."""
    m = cast_manifest()
    people = m.get("people", {})
    if not people:
        return "- (the cast's files are missing: use no people)"
    lines = [f'- {pid}: {p["label"]}, {p["desc"]}.' for pid, p in people.items()]
    lines.append(f'  Their poses: {", ".join(m.get("poses", []))}. Their faces: {", ".join(m.get("faces", []))}.')
    return "\n".join(lines)
