# Film logos - one shared library for every film

Every product logo a film shows lives here once, at `/film-art/logos/<group>/<name>.svg`, grouped by where it came
from (each source has its own terms). Until November 2026 each daily video kept its own copy in
`film-art/daily3/logos`, `daily4/logos`, `daily5/logos` and `daily6/logos`: 136 files, but only 105 different
pictures. Merged on 2026-11-11; the four daily films were pointed here and nothing else in them changed.

**Adding a logo:** check that it isn't already here (look in all four groups), put it in the group of its source, add
its name to the list below, and never put a second copy in a film's own folder. A name can exist in two groups
(`brands/redis` is the Redis brand mark, `azure/redis` is Azure Managed Redis), so always use the group in the path.

## brands - Simple Icons 16.37.0
https://simpleicons.org, CC0 for the files, each drawn in its brand's colour. Each logo is its owner's trademark, used
only to name the product. Guidelines checked per logo, for example MySQL https://www.mysql.com/about/legal/logos.html
and Python https://www.python.org/community/logos/.

actions, apple, argo, caddy, docker, gcloud, git, gitea, github (#181717), grafana, haproxy (#169BD6), helm, jaeger,
k3s, kafka, kubernetes, linux, mysql, nginx, node, opensearch, opentofu, otel, owasp (#000000), postgres, prometheus,
python, rabbitmq, redis, terraform

## aws - AWS Architecture Icons, package of 31 July 2026
https://aws.amazon.com/architecture/icons/, unchanged. AWS allows customers and partners to use them to create
architecture diagrams.

Service icons: acm, apigateway, aurora, bedrock, cloudformation, cloudfront, cloudtrail, cloudwatch, codebuild,
codepipeline, config, dynamodb, ebs, ec2, ecr, ecs, efs, eks, elasticache, elb, eventbridge, fargate, iam, lambda, rds,
route53, s3, sagemaker, secrets, shield, sns, sqs, stepfunctions, vpc, waf (AWS WAF), xray.
Resource icons: alb, bucket (S3 bucket with objects), nat (VPC NAT gateway), nlb.

## azure - Azure Architecture Icons, package V25
Azure_Public_Service_Icons_V25.zip, the November 2026 update, from
https://learn.microsoft.com/en-us/azure/architecture/icons/, unchanged. Microsoft's terms: the icons may be used in
architectural diagrams, training materials or documentation; **never cropped, flipped, rotated or distorted**, and the
product's name shown close to each one (label every box).

By the name used here: acr (Container Registries), activitylog (Activity Log), aks (Kubernetes Services), apim (API
Management Services), appgw (Application Gateways), appinsights (Application Insights), appservice (App Services),
caenv (Container Apps Environments), containerapp (Worker Container App), cosmos (Azure Cosmos DB), dns (DNS Zones, used
for Azure DNS and for a private DNS zone), eventgrid (Event Grid Topics), eventhubs (Event Hubs), foundry (AI Foundry,
the icon Microsoft Foundry uses), frontdoor (Front Door and CDN Profiles), functions (Function Apps), identity (Managed
Identities), keyvault (Key Vaults), kusto (Azure Data Explorer Clusters), loganalytics (Log Analytics Workspaces),
monitor (Monitor), nsg (Network Security Groups), policy (Policy), privateendpoint (Private Endpoints), privatelink
(Private Link), redis (Azure Managed Redis), roles (Entra Identity Roles and Administrators), servicebus (Azure Service
Bus), sqldb (SQL Database), sqlserver (SQL Server), storage (Storage Accounts), vm (Virtual Machine), vnet (Virtual
Networks), waf (Web Application Firewall Policies).

## drawn - our own drawings
phone (a plain phone, used where a real app's logo or screen must not appear: no WhatsApp logo or app screen is drawn
in any film).

## Logos the films deliberately do NOT use
Uber's logo (Daily 4 names Uber and quotes its engineering blog on plain cards). Stand-ins in a film (a small DNS
server, Docker networks) are named in words, not drawn with a product's logo.

## Used by
yt-one-order-every-tool (Daily 3), yt-one-server-to-millions (Daily 4), yt-aws-piece-by-piece (Daily 5),
yt-azure-behind-the-front-door (Daily 6).
