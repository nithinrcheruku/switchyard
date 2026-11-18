# ------------------------------------------------------------------------------
# 1. Enable Required Google Cloud APIs
# ------------------------------------------------------------------------------
locals {
  required_apis = [
    "apigee.googleapis.com",
    "aiplatform.googleapis.com",
    "modelarmor.googleapis.com",
    "compute.googleapis.com",
    "cloudkms.googleapis.com",
    "servicenetworking.googleapis.com",
    "iam.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "cloudtrace.googleapis.com",
    "secretmanager.googleapis.com"
  ]
}

resource "google_project_service" "apis" {
  for_each           = toset(local.required_apis)
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

# ------------------------------------------------------------------------------
# 2. Least-Privilege Runtime Service Account for Apigee -> Vertex AI & Model Armor
# ------------------------------------------------------------------------------
data "google_project" "current" {
  project_id = var.project_id
}

resource "google_service_account" "apigee_vertex_runtime" {
  project      = var.project_id
  account_id   = "apigee-vertex-router-sa"
  display_name = "Apigee AI Gateway Runtime SA (Vertex AI & Model Armor)"
  depends_on   = [google_project_service.apis]
}

# Allow Apigee's service agent to mint access tokens for the proxy runtime SA
resource "google_service_account_iam_member" "apigee_sa_token_creator" {
  service_account_id = google_service_account.apigee_vertex_runtime.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-apigee.iam.gserviceaccount.com"
}

# Principle of Least Privilege: Grant ONLY Vertex AI User and Model Armor User
resource "google_project_iam_member" "vertex_ai_user" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.apigee_vertex_runtime.email}"
}

resource "google_project_iam_member" "model_armor_user" {
  project = var.project_id
  role    = "roles/modelarmor.user"
  member  = "serviceAccount:${google_service_account.apigee_vertex_runtime.email}"
}

resource "google_project_iam_member" "logging_log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.apigee_vertex_runtime.email}"
}

# ------------------------------------------------------------------------------
# 3. Apigee X Organization, Instance, Environment & Group (PAYG + PSC)
# ------------------------------------------------------------------------------
resource "google_compute_network" "apigee_vpc" {
  count                   = var.use_existing_apigee_org ? 0 : 1
  project                 = var.project_id
  name                    = "apigee-coding-gateway-vpc"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.apis]
}

resource "google_apigee_organization" "org" {
  count                             = var.use_existing_apigee_org ? 0 : 1
  project_id                        = var.project_id
  analytics_region                  = var.region
  runtime_type                      = "CLOUD"
  billing_type                      = var.billing_type
  disable_vpc_peering               = true # Uses Private Service Connect (PSC)
  api_consumer_data_location        = var.region
  control_plane_encryption_key_name = null
  depends_on                        = [google_project_service.apis]
}

locals {
  apigee_org_id    = var.use_existing_apigee_org ? "organizations/${var.project_id}" : google_apigee_organization.org[0].id
  apigee_org_name  = var.project_id
  gateway_hostname = var.custom_domain
}

resource "google_apigee_environment" "env" {
  count       = var.use_existing_apigee_org ? 0 : 1
  org_id      = local.apigee_org_id
  name        = var.apigee_env
  description = "Enterprise Coding Agent AI Gateway Environment (Claude Code, Antigravity, Codex)"
  type        = "COMPREHENSIVE"
}

resource "google_apigee_instance" "instance" {
  count    = var.use_existing_apigee_org ? 0 : 1
  org_id   = local.apigee_org_id
  name     = "apigee-${var.region}"
  location = var.region
}

resource "google_apigee_instance_attachment" "env_attachment" {
  count       = var.use_existing_apigee_org ? 0 : 1
  instance_id = google_apigee_instance.instance[0].id
  environment = google_apigee_environment.env[0].name
}

resource "google_apigee_envgroup" "envgroup" {
  count     = var.use_existing_apigee_org ? 0 : 1
  org_id    = local.apigee_org_id
  name      = var.apigee_envgroup
  hostnames = [local.gateway_hostname]
}

resource "google_apigee_envgroup_attachment" "envgroup_attachment" {
  count       = var.use_existing_apigee_org ? 0 : 1
  envgroup_id = google_apigee_envgroup.envgroup[0].id
  environment = google_apigee_environment.env[0].name
}

# ------------------------------------------------------------------------------
# 4. Private Service Connect (PSC) + Internal HTTPS Application Load Balancer
#    Per official Antigravity Enterprise Gateway docs:
#    "Don't give the gateway a public endpoint. Place it behind an internal
#     Application Load Balancer reachable only from your corporate network/VPC."
# ------------------------------------------------------------------------------
resource "google_compute_subnetwork" "proxy_only_subnet" {
  count         = var.use_existing_apigee_org ? 0 : 1
  project       = var.project_id
  name          = "apigee-ilb-proxy-subnet-${var.region}"
  region        = var.region
  network       = google_compute_network.apigee_vpc[0].id
  ip_cidr_range = "10.129.0.0/23"
  purpose       = "REGIONAL_MANAGED_PROXY"
  role          = "ACTIVE"
}

resource "google_compute_subnetwork" "ilb_client_subnet" {
  count         = var.use_existing_apigee_org ? 0 : 1
  project       = var.project_id
  name          = "apigee-ilb-client-subnet-${var.region}"
  region        = var.region
  network       = google_compute_network.apigee_vpc[0].id
  ip_cidr_range = "10.128.0.0/24"
}

resource "google_compute_address" "gateway_internal_ip" {
  count        = var.use_existing_apigee_org ? 0 : 1
  project      = var.project_id
  name         = "apigee-coding-gateway-ilb-ip"
  region       = var.region
  address_type = "INTERNAL"
  subnetwork   = google_compute_subnetwork.ilb_client_subnet[0].id
  depends_on   = [google_project_service.apis]
}

resource "google_compute_region_network_endpoint_group" "apigee_psc_neg" {
  count                 = var.use_existing_apigee_org ? 0 : 1
  provider              = google-beta
  project               = var.project_id
  name                  = "apigee-psc-neg-${var.region}"
  region                = var.region
  network_endpoint_type = "PRIVATE_SERVICE_CONNECT"
  psc_target_service    = google_apigee_instance.instance[0].service_attachment
  network               = google_compute_network.apigee_vpc[0].id
  subnetwork            = google_compute_subnetwork.ilb_client_subnet[0].id
}

resource "google_compute_region_backend_service" "apigee_backend" {
  count                 = var.use_existing_apigee_org ? 0 : 1
  project               = var.project_id
  name                  = "apigee-coding-gateway-ilb-backend"
  region                = var.region
  protocol              = "HTTPS"
  load_balancing_scheme = "INTERNAL_MANAGED"
  timeout_sec           = 3600

  backend {
    group          = google_compute_region_network_endpoint_group.apigee_psc_neg[0].id
    balancing_mode = "UTILIZATION"
  }
}

resource "google_compute_region_url_map" "apigee_url_map" {
  count           = var.use_existing_apigee_org ? 0 : 1
  project         = var.project_id
  name            = "apigee-coding-gateway-ilb-urlmap"
  region          = var.region
  default_service = google_compute_region_backend_service.apigee_backend[0].id
}

resource "google_compute_region_ssl_certificate" "apigee_ilb_cert" {
  count       = var.use_existing_apigee_org ? 0 : 1
  project     = var.project_id
  name        = "apigee-coding-gateway-ilb-cert"
  region      = var.region
  private_key = var.tls_private_key_pem
  certificate = var.tls_certificate_pem
}

resource "google_compute_region_target_https_proxy" "apigee_target_proxy" {
  count            = var.use_existing_apigee_org ? 0 : 1
  project          = var.project_id
  name             = "apigee-coding-gateway-ilb-https-proxy"
  region           = var.region
  url_map          = google_compute_region_url_map.apigee_url_map[0].id
  ssl_certificates = [google_compute_region_ssl_certificate.apigee_ilb_cert[0].id]
}

resource "google_compute_forwarding_rule" "apigee_ilb_forwarding_rule" {
  count                 = var.use_existing_apigee_org ? 0 : 1
  project               = var.project_id
  name                  = "apigee-coding-gateway-ilb-fwd-rule"
  region                = var.region
  load_balancing_scheme = "INTERNAL_MANAGED"
  ip_protocol           = "TCP"
  port_range            = "443"
  network               = google_compute_network.apigee_vpc[0].id
  subnetwork            = google_compute_subnetwork.ilb_client_subnet[0].id
  ip_address            = google_compute_address.gateway_internal_ip[0].id
  target                = google_compute_region_target_https_proxy.apigee_target_proxy[0].id
  depends_on            = [google_compute_subnetwork.proxy_only_subnet]
}

resource "google_dns_managed_zone" "internal_gateway_zone" {
  count      = var.use_existing_apigee_org ? 0 : 1
  project    = var.project_id
  name       = "apigee-coding-gateway-private-zone"
  dns_name   = "${var.custom_domain}."
  visibility = "private"

  private_visibility_config {
    networks {
      network_url = google_compute_network.apigee_vpc[0].id
    }
  }
}

resource "google_dns_record_set" "internal_gateway_a_record" {
  count        = var.use_existing_apigee_org ? 0 : 1
  project      = var.project_id
  name         = "${var.custom_domain}."
  type         = "A"
  ttl          = 300
  managed_zone = google_dns_managed_zone.internal_gateway_zone[0].name
  rrdatas      = [google_compute_address.gateway_internal_ip[0].address]
}

# ------------------------------------------------------------------------------
# 5. Apigee API Proxies, Deployments, API Products, Token Quotas, Developers & Apps
# ------------------------------------------------------------------------------
locals {
  apigee_proxies = toset([
    "claude-code-gateway",
    "antigravity-gateway",
    "codex-gateway",
  ])
}

resource "google_apigee_api" "proxies" {
  for_each       = local.apigee_proxies
  name           = each.key
  org_id         = local.apigee_org_name
  config_bundle  = "${path.module}/../build/${var.apigee_stage}/${each.key}.zip"
  detect_md5hash = filemd5("${path.module}/../build/${var.apigee_stage}/${each.key}.zip")
  depends_on     = [google_apigee_environment.env]
}

resource "google_apigee_environment_api_revision_deployment" "proxy_deployments" {
  for_each        = local.apigee_proxies
  org_id          = local.apigee_org_name
  environment     = var.apigee_env
  api             = google_apigee_api.proxies[each.key].name
  revision        = tonumber(google_apigee_api.proxies[each.key].latest_revision_id)
  override        = true
  service_account = google_service_account.apigee_vertex_runtime.email
  depends_on = [
    google_apigee_environment.env,
    google_apigee_data_collector.finops,
    google_service_account_iam_member.apigee_sa_token_creator,
    google_project_iam_member.vertex_ai_user,
    google_project_iam_member.model_armor_user,
    google_project_iam_member.logging_log_writer,
    google_model_armor_template.coding_agent_armor_prod,
  ]
}

resource "google_apigee_api_product" "coding_agent_standard" {
  org_id        = local.apigee_org_id
  name          = "coding-agent-standard"
  display_name  = "Coding Agent Standard Tier (Gemini Flash, Gemini 3.1 Pro, Qwen3-Coder, GLM 5.2, Claude Sonnet)"
  approval_type = "auto"
  environments  = [var.apigee_env]
  proxies       = ["claude-code-gateway", "antigravity-gateway", "codex-gateway"]

  attributes {
    name  = "access"
    value = "private"
  }
  attributes {
    name  = "llmQuota"
    value = var.standard_tier_daily_token_quota
  }
  attributes {
    name  = "daily_token_quota"
    value = var.standard_tier_daily_token_quota
  }
  attributes {
    name  = "llmQuotaInterval"
    value = "1"
  }
  attributes {
    name  = "llmQuotaTimeUnit"
    value = "day"
  }
  attributes {
    name  = "allowed_model_tiers"
    value = "tier1-fast,tier2-daily,tier4-open"
  }
  attributes {
    name  = "allowedModels"
    value = "gemini-3.8-flash,gemini-3.5-flash,gemini-3-flash-preview,gemini-3.5-flash-lite,gemini-3.1-flash-lite-preview,gemini-3.1-pro-preview,gemini-3.1-pro,gemini-2.5-pro,gemini-2.5-flash,gemini-decision-1,claude-sonnet-5-5,claude-sonnet-4-6,claude-haiku-5-5,claude-haiku-4-5,qwen3-coder,qwen3-next-80b-thinking,deepseek-v4.1-flash,deepseek-v3.2,deepseek-r1,glm-5,glm-5.2,kimi-k2,kimi-k2.6,llama-4-maverick,llama-4-scout,gpt-oss-120b,gemma-4-26b,minimax-m2,mistral-medium-3,codestral-2,grok-4.7,muse-spark,smart-router,auto,switchyard-auto"
  }
  attributes {
    name  = "tierName"
    value = "coding-agent-standard"
  }
  attributes {
    name  = "finops_ingestion_mode"
    value = upper(var.finops_ingestion_mode)
  }

  depends_on = [
    google_apigee_environment.env,
    google_apigee_environment_api_revision_deployment.proxy_deployments,
  ]
}

resource "google_apigee_api_product" "coding_agent_frontier" {
  org_id        = local.apigee_org_id
  name          = "coding-agent-frontier"
  display_name  = "Coding Agent Frontier Tier (All Standard Models + Claude Opus 4.7)"
  approval_type = "auto"
  environments  = [var.apigee_env]
  proxies       = ["claude-code-gateway", "antigravity-gateway", "codex-gateway"]

  attributes {
    name  = "access"
    value = "private"
  }
  attributes {
    name  = "llmQuota"
    value = var.frontier_tier_daily_token_quota
  }
  attributes {
    name  = "daily_token_quota"
    value = var.frontier_tier_daily_token_quota
  }
  attributes {
    name  = "llmQuotaInterval"
    value = "1"
  }
  attributes {
    name  = "llmQuotaTimeUnit"
    value = "day"
  }
  attributes {
    name  = "allowed_model_tiers"
    value = "tier1-fast,tier2-daily,tier3-frontier,tier4-open"
  }
  attributes {
    name  = "allowedModels"
    value = "gemini-4-argon,gemini-3.8-flash,gemini-3.5-flash,gemini-3-flash-preview,gemini-3.5-flash-lite,gemini-3.1-flash-lite-preview,gemini-3.1-pro-preview,gemini-3.1-pro,gemini-2.5-pro,gemini-2.5-flash,gemini-decision-1,claude-opus-5-5,claude-opus-4-8,claude-opus-4-7,claude-opus-4-6,claude-fable-5-1,claude-sonnet-5-5,claude-sonnet-4-6,claude-haiku-5-5,claude-haiku-4-5,qwen3-coder,qwen3-next-80b-thinking,deepseek-v4.1-flash,deepseek-v3.2,deepseek-r1,glm-5,glm-5.2,kimi-k2,kimi-k2.6,llama-4-maverick,llama-4-scout,gpt-oss-120b,gemma-4-26b,minimax-m2,mistral-medium-3,codestral-2,grok-4.7,muse-spark,smart-router,auto,switchyard-auto"
  }
  attributes {
    name  = "tierName"
    value = "coding-agent-frontier"
  }
  attributes {
    name  = "finops_ingestion_mode"
    value = upper(var.finops_ingestion_mode)
  }

  depends_on = [
    google_apigee_environment.env,
    google_apigee_environment_api_revision_deployment.proxy_deployments,
  ]
}

resource "google_apigee_developer" "devs" {
  for_each   = { for d in var.developers : d.email => d }
  org_id     = local.apigee_org_id
  email      = each.value.email
  first_name = each.value.first_name
  last_name  = each.value.last_name
  user_name  = each.value.user_name

  attributes {
    name  = "team"
    value = each.value.team
  }
  attributes {
    name  = "cost_center"
    value = each.value.cost_center
  }
  attributes {
    name  = "product_tier"
    value = each.value.tier == "frontier" ? "coding-agent-frontier" : "coding-agent-standard"
  }

  depends_on = [google_apigee_environment.env]
}

resource "google_apigee_developer_app" "dev_apps" {
  for_each        = { for d in var.developers : d.email => d }
  org_id          = local.apigee_org_id
  name            = "${each.value.user_name}-coding-agent-app"
  developer_email = google_apigee_developer.devs[each.key].email
  callback_url    = "https://127.0.0.1/callback"

  api_products = [
    each.value.tier == "frontier" ? google_apigee_api_product.coding_agent_frontier.name : google_apigee_api_product.coding_agent_standard.name
  ]

  attributes {
    name  = "team"
    value = each.value.team
  }
  attributes {
    name  = "cost_center"
    value = each.value.cost_center
  }
  attributes {
    name  = "credential_type"
    value = coalesce(each.value.credential_type, "user_key")
  }
}

# ------------------------------------------------------------------------------
# 6. Apigee FinOps Data Collectors & Google Cloud Model Armor Template
# ------------------------------------------------------------------------------
locals {
  finops_data_collectors = {
    dc_developer_email              = "STRING"
    dc_gateway_key_name             = "STRING"
    dc_credential_type              = "STRING"
    dc_product_tier                 = "STRING"
    dc_coding_harness               = "STRING"
    dc_requested_model              = "STRING"
    dc_routed_model                 = "STRING"
    dc_target_vertex_model          = "STRING"
    dc_routing_tier                 = "STRING"
    dc_team_name                    = "STRING"
    dc_cost_center                  = "STRING"
    dc_prompt_tokens                = "INTEGER"
    dc_completion_tokens            = "INTEGER"
    dc_cached_tokens                = "INTEGER"
    dc_total_tokens                 = "INTEGER"
    dc_estimated_cost_usd           = "FLOAT"
    dc_net_cash_cost_usd            = "FLOAT"
    dc_frontier_baseline_cost_usd   = "FLOAT"
    dc_routing_savings_usd          = "FLOAT"
    dc_routing_mode                 = "STRING"
    dc_recommended_tier             = "STRING"
    dc_avoidable_frontier_spend_usd = "FLOAT"
    dc_workload_category            = "STRING"
    dc_cache_hit_rate_pct           = "FLOAT"
    dc_session_id                   = "STRING"
    dc_project_name                 = "STRING"
    dc_funding_pool                 = "STRING"
    dc_total_latency_ms             = "INTEGER"
    dc_ttft_ms                      = "INTEGER"
    dc_ingestion_mode               = "STRING"
    dc_cache_hit                    = "BOOLEAN"
    dc_fallback_used                = "BOOLEAN"
  }
}

resource "google_apigee_data_collector" "finops" {
  for_each          = local.finops_data_collectors
  org_id            = local.apigee_org_id
  data_collector_id = each.key
  description       = "Switchyard FinOps & Governance telemetry field (${each.key})"
  type              = each.value
  depends_on        = [google_apigee_environment.env]
}

resource "google_model_armor_template" "coding_agent_armor_prod" {
  location    = var.region
  project     = var.project_id
  template_id = "coding-agent-armor-prod"

  filter_config {
    # Sensitive Data Protection (basic): detects credentials/secrets and common PII
    # infoTypes in prompts and responses. Apigee SanitizeUserPrompt/SanitizeModelResponse
    # block matches (HTTP 400); they do not redact. Use advanced_config with DLP
    # inspect/de-identify templates for custom infoTypes.
    sdp_settings {
      basic_config {
        filter_enforcement = "ENABLED"
      }
    }
    pi_and_jailbreak_filter_settings {
      filter_enforcement = "ENABLED"
      confidence_level   = "MEDIUM_AND_ABOVE"
    }
    malicious_uri_filter_settings {
      filter_enforcement = "ENABLED"
    }
    rai_settings {
      rai_filters {
        filter_type      = "DANGEROUS"
        confidence_level = "HIGH"
      }
      rai_filters {
        filter_type      = "HATE_SPEECH"
        confidence_level = "HIGH"
      }
      rai_filters {
        filter_type      = "HARASSMENT"
        confidence_level = "HIGH"
      }
      rai_filters {
        filter_type      = "SEXUALLY_EXPLICIT"
        confidence_level = "HIGH"
      }
    }
  }

  template_metadata {
    log_template_operations = true
    log_sanitize_operations = true
  }

  depends_on = [google_project_service.apis]
}

locals {
  finops_log_filter = "logName=\"projects/${var.project_id}/logs/apigee-ai-finops\" AND jsonPayload.event_type=\"ai_router_finops_turn\""
  finops_metric_labels = [
    { key = "developer_email", description = "Developer identity email" },
    { key = "team_name", description = "Engineering team name" },
    { key = "coding_harness", description = "Client coding harness" },
    { key = "routed_model", description = "Executed Vertex AI model" },
    { key = "actual_tier", description = "Executed model tier" },
    { key = "recommended_tier", description = "Smart Router recommended tier" },
    { key = "routing_mode", description = "Routing mode (smart_auto, daily_direct, manual_frontier_pin)" },
    { key = "workload_category", description = "Classified engineering workload category" },
    { key = "funding_pool", description = "Funding pool (Antigravity Gemini Credit Pool vs GCP FSP)" },
    { key = "project_name", description = "Active repository/workspace" },
  ]
  finops_label_extractors = {
    developer_email   = "EXTRACT(jsonPayload.developer_email)"
    team_name         = "EXTRACT(jsonPayload.team_name)"
    coding_harness    = "EXTRACT(jsonPayload.coding_harness)"
    routed_model      = "EXTRACT(jsonPayload.routed_model)"
    actual_tier       = "EXTRACT(jsonPayload.actual_tier)"
    recommended_tier  = "EXTRACT(jsonPayload.recommended_tier)"
    routing_mode      = "EXTRACT(jsonPayload.routing_mode)"
    workload_category = "EXTRACT(jsonPayload.workload_category)"
    funding_pool      = "EXTRACT(jsonPayload.funding_pool)"
    project_name      = "EXTRACT(jsonPayload.project_name)"
  }
  finops_governance_labels = [
    { key = "developer_email", description = "Developer identity email" },
    { key = "team_name", description = "Engineering team name" },
    { key = "coding_harness", description = "Client coding harness" },
    { key = "routing_mode", description = "Routing mode (smart_auto, daily_direct, manual_frontier_pin)" },
    { key = "project_name", description = "Active repository/workspace" },
    { key = "routed_model", description = "Executed Vertex AI model" },
    { key = "workload_category", description = "Classified engineering workload category" },
    { key = "is_subagent", description = "Whether turn originated from a background subagent" },
    { key = "smart_router_decision", description = "Smart Router heuristic or judge classification reason" },
    { key = "is_router_override", description = "Whether developer manually overrode Smart Router tier" },
  ]
  finops_governance_extractors = {
    developer_email       = "EXTRACT(jsonPayload.developer_email)"
    team_name             = "EXTRACT(jsonPayload.team_name)"
    coding_harness        = "EXTRACT(jsonPayload.coding_harness)"
    routing_mode          = "EXTRACT(jsonPayload.routing_mode)"
    project_name          = "EXTRACT(jsonPayload.project_name)"
    routed_model          = "EXTRACT(jsonPayload.routed_model)"
    workload_category     = "EXTRACT(jsonPayload.workload_category)"
    is_subagent           = "EXTRACT(jsonPayload.is_subagent)"
    smart_router_decision = "EXTRACT(jsonPayload.smart_router_decision)"
    is_router_override    = "EXTRACT(jsonPayload.is_router_override)"
  }
  finops_distribution_metrics = {
    ai_router_actual_cost_usd = {
      description     = "Actual Vertex AI list cost (USD) per coding agent turn"
      value_extractor = "EXTRACT(jsonPayload.actual_cost_usd)"
      scale           = 0.00001
    }
    ai_router_savings_usd = {
      description     = "Smart Router savings vs unrouted Frontier Opus baseline (USD)"
      value_extractor = "EXTRACT(jsonPayload.routing_savings_usd)"
      scale           = 0.00001
    }
    ai_router_avoidable_frontier_spend_usd = {
      description     = "Avoidable Frontier Overkill Spend (Left-on-the-Table Savings USD when pinning Frontier on routine turns)"
      value_extractor = "EXTRACT(jsonPayload.avoidable_frontier_spend_usd)"
      scale           = 0.00001
    }
    ai_router_total_tokens = {
      description     = "Total tokens (input + output) per coding agent turn"
      value_extractor = "EXTRACT(jsonPayload.total_tokens)"
      scale           = 1.0
    }
    ai_router_cached_tokens = {
      description     = "Prompt cache read tokens per coding agent turn"
      value_extractor = "EXTRACT(jsonPayload.cached_tokens)"
      scale           = 1.0
    }
  }
  # Dedicated 10-label attribution & latency descriptor (respects GCP Cloud Logging 10-label limit)
  # for Gateway Key chargeback, User vs Service Key leaderboard isolation, True Net Cash, and TTFT.
  finops_attribution_labels = [
    { key = "developer_email", description = "Developer or delegated user identity" },
    { key = "team_name", description = "Engineering team name" },
    { key = "cost_center", description = "Chargeback cost center" },
    { key = "coding_harness", description = "Client coding harness" },
    { key = "routed_model", description = "Executed Vertex AI model" },
    { key = "gateway_key_name", description = "Apigee Developer App / Gateway Key name" },
    { key = "credential_type", description = "Credential class (user_key, oidc_user, service_key)" },
    { key = "funding_pool", description = "Funding pool (Antigravity Gemini Credit Pool vs GCP FSP)" },
    { key = "environment", description = "Execution environment tag (production, staging, ci)" },
    { key = "ingestion_mode", description = "FinOps privacy ingestion mode (USAGE, FULL)" },
  ]
  finops_attribution_extractors = {
    developer_email  = "EXTRACT(jsonPayload.developer_email)"
    team_name        = "EXTRACT(jsonPayload.team_name)"
    cost_center      = "EXTRACT(jsonPayload.cost_center)"
    coding_harness   = "EXTRACT(jsonPayload.coding_harness)"
    routed_model     = "EXTRACT(jsonPayload.routed_model)"
    gateway_key_name = "EXTRACT(jsonPayload.gateway_key_name)"
    credential_type  = "EXTRACT(jsonPayload.credential_type)"
    funding_pool     = "EXTRACT(jsonPayload.funding_pool)"
    environment      = "EXTRACT(jsonPayload.environment)"
    ingestion_mode   = "EXTRACT(jsonPayload.ingestion_mode)"
  }
  finops_attribution_distributions = {
    ai_router_net_cash_usd = {
      description     = "True Net GCP Invoice Cash Outlay (USD) after $0 Gemini Seat Credit Pool and FSP commit discount"
      value_extractor = "EXTRACT(jsonPayload.net_cash_cost_usd)"
      scale           = 0.00001
    }
    ai_router_key_cost_usd = {
      description     = "Vertex AI list cost (USD) attributed by Gateway Key and Credential Type (user_key vs service_key)"
      value_extractor = "EXTRACT(jsonPayload.actual_cost_usd)"
      scale           = 0.00001
    }
    ai_router_ttft_ms = {
      description     = "Streaming Time-to-First-Token (TTFT ms) per coding agent turn"
      value_extractor = "EXTRACT(jsonPayload.ttft_ms)"
      scale           = 1.0
    }
    ai_router_latency_ms = {
      description     = "End-to-end turn latency (ms) per coding agent turn"
      value_extractor = "EXTRACT(jsonPayload.total_latency_ms)"
      scale           = 1.0
    }
  }
}

resource "google_logging_metric" "ai_router_turn_count" {
  project     = var.project_id
  name        = "ai_router_turn_count"
  description = "Count of coding agent turns routed through Apigee X Vertex AI Gateway"
  filter      = local.finops_log_filter

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    dynamic "labels" {
      for_each = local.finops_metric_labels
      content {
        key         = labels.value.key
        value_type  = "STRING"
        description = labels.value.description
      }
    }
  }

  label_extractors = local.finops_label_extractors
  depends_on       = [google_project_service.apis]
}

resource "google_logging_metric" "ai_router_governance_turns" {
  project     = var.project_id
  name        = "ai_router_governance_turns"
  description = "Subagent isolation, Smart Router judge auditability, and override turn counts"
  filter      = local.finops_log_filter

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    dynamic "labels" {
      for_each = local.finops_governance_labels
      content {
        key         = labels.value.key
        value_type  = "STRING"
        description = labels.value.description
      }
    }
  }

  label_extractors = local.finops_governance_extractors
  depends_on       = [google_project_service.apis]
}

resource "google_logging_metric" "ai_router_governance_cost_usd" {
  project         = var.project_id
  name            = "ai_router_governance_cost_usd"
  description     = "Subagent vs Main Agent and Router Override spend (USD)"
  filter          = local.finops_log_filter
  value_extractor = "EXTRACT(jsonPayload.actual_cost_usd)"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = "1"
    dynamic "labels" {
      for_each = local.finops_governance_labels
      content {
        key         = labels.value.key
        value_type  = "STRING"
        description = labels.value.description
      }
    }
  }

  bucket_options {
    exponential_buckets {
      num_finite_buckets = 64
      growth_factor      = 1.4
      scale              = 0.00001
    }
  }

  label_extractors = local.finops_governance_extractors
  depends_on       = [google_project_service.apis]
}

resource "google_logging_metric" "ai_router_distributions" {
  for_each        = local.finops_distribution_metrics
  project         = var.project_id
  name            = each.key
  description     = each.value.description
  filter          = local.finops_log_filter
  value_extractor = each.value.value_extractor

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = "1"
    dynamic "labels" {
      for_each = local.finops_metric_labels
      content {
        key         = labels.value.key
        value_type  = "STRING"
        description = labels.value.description
      }
    }
  }

  bucket_options {
    exponential_buckets {
      num_finite_buckets = 64
      growth_factor      = 1.4
      scale              = each.value.scale
    }
  }

  label_extractors = local.finops_label_extractors
  depends_on       = [google_project_service.apis]
}

resource "google_logging_metric" "ai_router_attribution_turns" {
  project     = var.project_id
  name        = "ai_router_attribution_turns"
  description = "Coding agent turn counts attributed by Gateway Key and Credential Type (excludes service_key on human user leaderboards)"
  filter      = local.finops_log_filter

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    dynamic "labels" {
      for_each = local.finops_attribution_labels
      content {
        key         = labels.value.key
        value_type  = "STRING"
        description = labels.value.description
      }
    }
  }

  label_extractors = local.finops_attribution_extractors
  depends_on       = [google_project_service.apis]
}

resource "google_logging_metric" "ai_router_attribution_distributions" {
  for_each        = local.finops_attribution_distributions
  project         = var.project_id
  name            = each.key
  description     = each.value.description
  filter          = local.finops_log_filter
  value_extractor = each.value.value_extractor

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = "1"
    dynamic "labels" {
      for_each = local.finops_attribution_labels
      content {
        key         = labels.value.key
        value_type  = "STRING"
        description = labels.value.description
      }
    }
  }

  bucket_options {
    exponential_buckets {
      num_finite_buckets = 64
      growth_factor      = 1.4
      scale              = each.value.scale
    }
  }

  label_extractors = local.finops_attribution_extractors
  depends_on       = [google_project_service.apis]
}

resource "google_monitoring_dashboard" "coding_agent_finops_dashboard" {
  project = var.project_id
  dashboard_json = replace(
    replace(
      replace(file("${path.module}/finops-dashboard.json"), "@GCP_PROJECT_ID@", var.project_id),
      "@GEMINI_POOL_SUMMARY@",
      var.gemini_pool_summary
    ),
    "@GCP_FSP_DISCOUNT_PCT@",
    var.gcp_fsp_discount_pct
  )
  depends_on = [
    google_project_service.apis,
    google_logging_metric.ai_router_turn_count,
    google_logging_metric.ai_router_governance_turns,
    google_logging_metric.ai_router_governance_cost_usd,
    google_logging_metric.ai_router_distributions,
    google_logging_metric.ai_router_attribution_turns,
    google_logging_metric.ai_router_attribution_distributions,
  ]
}

# ------------------------------------------------------------------------------
# 7. Native GCP Cloud Monitoring FinOps Spend, Overkill Waste & Quota Alerts
# ------------------------------------------------------------------------------
resource "google_monitoring_alert_policy" "finops_daily_net_cash_spend" {
  count                 = var.enable_finops_alerts ? 1 : 0
  project               = var.project_id
  display_name          = "AI Gateway FinOps — 24h Net GCP Cash Spend > $${var.daily_net_cash_alert_threshold_usd}"
  combiner              = "OR"
  notification_channels = var.finops_notification_channels

  documentation {
    mime_type = "text/markdown"
    content   = "24-hour **True Net GCP Invoice Cash** outlay across Anthropic Claude and Open-Weight MaaS models exceeded **$${var.daily_net_cash_alert_threshold_usd}**. Gemini turns covered by the pre-paid Antigravity Enterprise Seat Token Credit Pool (`$0` net cash) are already excluded. Inspect top Gateway Keys and Developers in the **Coding Agent Enterprise FinOps & Multi-Harness Governance** dashboard."
  }

  conditions {
    display_name = "24h Net Cash Spend USD exceeds threshold"
    condition_prometheus_query_language {
      query    = "sum(sum_over_time(logging_googleapis_com:user_ai_router_net_cash_usd_sum{monitored_resource=\"global\"}[24h])) > ${var.daily_net_cash_alert_threshold_usd}"
      duration = "300s"
    }
  }

  depends_on = [google_logging_metric.ai_router_attribution_distributions]
}

resource "google_monitoring_alert_policy" "finops_avoidable_overkill" {
  count                 = var.enable_finops_alerts ? 1 : 0
  project               = var.project_id
  display_name          = "AI Gateway FinOps — Avoidable Frontier Overkill Waste > $${var.daily_overkill_alert_threshold_usd}/24h"
  combiner              = "OR"
  notification_channels = var.finops_notification_channels

  documentation {
    mime_type = "text/markdown"
    content   = "Engineers manually pinned Frontier models (`claude-opus-5-5` / `claude-opus-4-7`) on routine grep, test, or single-file edits, leaving **>$${var.daily_overkill_alert_threshold_usd}** on the table in the past 24 hours. Switch harnesses to `/model auto` (`vertex-connect claude auto`) to reclaim Smart Router savings."
  }

  conditions {
    display_name = "24h Avoidable Frontier Overkill USD exceeds threshold"
    condition_prometheus_query_language {
      query    = "sum(sum_over_time(logging_googleapis_com:user_ai_router_avoidable_frontier_spend_usd_sum{monitored_resource=\"global\"}[24h])) > ${var.daily_overkill_alert_threshold_usd}"
      duration = "300s"
    }
  }

  depends_on = [google_logging_metric.ai_router_distributions]
}

resource "google_monitoring_alert_policy" "finops_gateway_429_surge" {
  count                 = var.enable_finops_alerts ? 1 : 0
  project               = var.project_id
  display_name          = "AI Gateway Governance — Apigee Token Quota / Upstream HTTP 429 Surge"
  combiner              = "OR"
  notification_channels = var.finops_notification_channels

  documentation {
    mime_type = "text/markdown"
    content   = "Elevated HTTP `429` responses detected on Apigee coding agent proxies (`claude-code-gateway`, `codex-gateway`, `antigravity-gateway`), indicating developer `<LLMTokenQuota>` exhaustion or regional Vertex AI capacity pressure."
  }

  conditions {
    display_name = "Apigee ProxyV2 HTTP 429 count > 25 in 5m"
    condition_threshold {
      filter          = "metric.type=\"apigee.googleapis.com/proxyv2/response_count\" AND resource.type=\"apigee.googleapis.com/ProxyV2\" AND metric.label.\"response_code\"=\"429\""
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = 25
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  depends_on = [google_project_service.apis]
}

# ------------------------------------------------------------------------------
# 8. Optional Zero-Ops BigQuery FinOps Data Lake Sink (SQL Chargeback & BI)
#    Replaces self-hosted ClickHouse + Postgres + S3 with serverless BigQuery.
# ------------------------------------------------------------------------------
resource "google_bigquery_dataset" "finops_analytics" {
  count       = var.enable_finops_bigquery_export ? 1 : 0
  project     = var.project_id
  dataset_id  = "ai_gateway_finops"
  location    = var.region
  description = "Partitioned Cloud Logging FinOps sink for Apigee X Coding Agent Model Router (User/Service Key chargeback, W3C Trace IDs, Net Cash ROI)"
  depends_on  = [google_project_service.apis]
}

resource "google_logging_project_sink" "finops_bq_sink" {
  count                  = var.enable_finops_bigquery_export ? 1 : 0
  project                = var.project_id
  name                   = "apigee-ai-finops-bigquery-sink"
  destination            = "bigquery.googleapis.com/projects/${var.project_id}/datasets/${google_bigquery_dataset.finops_analytics[0].dataset_id}"
  filter                 = local.finops_log_filter
  unique_writer_identity = true

  bigquery_options {
    use_partitioned_tables = true
  }
}

resource "google_bigquery_dataset_iam_member" "finops_sink_writer" {
  count      = var.enable_finops_bigquery_export ? 1 : 0
  project    = var.project_id
  dataset_id = google_bigquery_dataset.finops_analytics[0].dataset_id
  role       = "roles/bigquery.dataEditor"
  member     = google_logging_project_sink.finops_bq_sink[0].writer_identity
}

# Optional: Cloud Audit Logs Data Access logs for Vertex AI (who called which model, when).
# Off by default because Data Access logs are billable; enable via var.enable_vertex_data_access_logs.
resource "google_project_iam_audit_config" "vertex_data_access" {
  count   = var.enable_vertex_data_access_logs ? 1 : 0
  project = var.project_id
  service = "aiplatform.googleapis.com"

  audit_log_config {
    log_type = "DATA_READ"
  }
  audit_log_config {
    log_type = "DATA_WRITE"
  }
}

# ------------------------------------------------------------------------------
# 9. Optional Gemini Decisions API (gemini-decision-1) Enablement & Encrypted KVM
#    Populates the `switchyard-secrets` Apigee environment KVM container; populate
#    the `gemini_decisions_api_key` entry out-of-band via Apigee KVM Entries API
#    so API keys never enter Terraform state.
# ------------------------------------------------------------------------------
resource "google_project_service" "generative_language_api" {
  count              = var.enable_gemini_decisions_api ? 1 : 0
  project            = var.project_id
  service            = "generativelanguage.googleapis.com"
  disable_on_destroy = false
}

resource "google_apigee_env_keyvaluemap" "decisions_secrets" {
  count  = var.enable_gemini_decisions_api ? 1 : 0
  env_id = "${local.apigee_org_id}/environments/${var.apigee_env}"
  name   = var.gemini_decisions_kvm_name

  depends_on = [
    google_apigee_environment.env,
    google_project_service.generative_language_api,
  ]
}

