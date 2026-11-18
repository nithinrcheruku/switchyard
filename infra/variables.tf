variable "project_id" {
  description = "Google Cloud Project ID hosting Apigee X and Vertex AI Model Garden."
  type        = string
}

variable "region" {
  description = "Primary GCP region for Apigee X runtime instance, PSC NEG, Internal ALB, and Model Armor."
  type        = string
  default     = "us-central1"
}

variable "apigee_env" {
  description = "Apigee X environment name where the coding agent proxies are deployed."
  type        = string
  default     = "ai-gateway-prod-comprehensive"
}

variable "apigee_stage" {
  description = "Compiled Apigee proxy bundle stage directory under build/<apigee_stage>/ to import and deploy."
  type        = string
  default     = "07-mvp-pilot"
}

variable "apigee_envgroup" {
  description = "Apigee X environment group name."
  type        = string
  default     = "ai-gateway-envgroup"
}

variable "use_existing_apigee_org" {
  description = "Set to true if an Apigee X organization already exists in this GCP project; false to bootstrap a new Apigee X Pay-As-You-Go (PAYG) organization."
  type        = bool
  default     = true
}

variable "billing_type" {
  description = "Apigee X billing type when creating a new organization (PAYG or EVALUATION or SUBSCRIPTION)."
  type        = string
  default     = "PAYG"
}

variable "custom_domain" {
  description = "Internal Cloud DNS private zone hostname for the Private Internal Application Load Balancer (e.g. switchyard.internal or ai-gw.internal.example.com)."
  type        = string
  default     = "switchyard.internal"
}

variable "cors_allowed_origin" {
  description = "Strict allow-listed CORS origin for browser/IDE extensions (avoid wildcard *)."
  type        = string
  default     = "https://console.cloud.google.com"
}

variable "standard_tier_daily_token_quota" {
  description = "Daily token quota (tokens/day, includes re-sent context) enforced by <LLMTokenQuota> for the coding-agent-standard API Product. Applies to API-key and Google sign-in (OIDC) developers; a developer attribute daily_token_quota overrides it per developer. Keep in sync with STANDARD_DEFAULT_QUOTA in src/ai-functions/extractAuthMode.js."
  type        = string
  default     = "5000000"
}

variable "frontier_tier_daily_token_quota" {
  description = "Daily token quota (tokens/day, includes re-sent context) enforced by <LLMTokenQuota> for the coding-agent-frontier API Product. Keep in sync with FRONTIER_DEFAULT_QUOTA in src/ai-functions/extractAuthMode.js."
  type        = string
  default     = "25000000"
}

variable "enable_vertex_data_access_logs" {
  description = "Enable Cloud Audit Logs DATA_READ/DATA_WRITE for aiplatform.googleapis.com (billable)."
  type        = bool
  default     = false
}

variable "gemini_pool_summary" {
  description = "Display summary for the enterprise Antigravity Gemini Token Credit Pool in Cloud Monitoring FinOps dashboards."
  type        = string
  default     = "$10/user/mo Enterprise Gemini Token Credit Pool"
}

variable "gcp_fsp_discount_pct" {
  description = "Enterprise GCP Flexible Spend Plan (FSP) / CUD discount percentage displayed in FinOps reports."
  type        = string
  default     = "15"
}

variable "finops_ingestion_mode" {
  description = "Default privacy-preserving FinOps ingestion mode across Apigee API Products: USAGE (default: model, tokens, cost, latency; zero prompt/completion content), FULL (bounded prompt/response/tool trace capture), or NONE (auth, routing, and rate limits only)."
  type        = string
  default     = "USAGE"
  validation {
    condition     = contains(["FULL", "USAGE", "NONE"], upper(var.finops_ingestion_mode))
    error_message = "finops_ingestion_mode must be FULL, USAGE, or NONE."
  }
}

variable "enable_finops_alerts" {
  description = "Provision native GCP Cloud Monitoring alert policies for daily Net Cash spend thresholds, Avoidable Frontier Overkill waste surges, and HTTP 429 quota spikes."
  type        = bool
  default     = true
}

variable "daily_net_cash_alert_threshold_usd" {
  description = "24-hour Net GCP Invoice Cash spend threshold (USD) that triggers a Cloud Monitoring FinOps alert."
  type        = number
  default     = 250
}

variable "daily_overkill_alert_threshold_usd" {
  description = "24-hour Avoidable Frontier Overkill spend threshold (USD) that alerts Engineering Managers to manual Frontier pinning on routine turns."
  type        = number
  default     = 50
}

variable "finops_notification_channels" {
  description = "List of Cloud Monitoring Notification Channel resource names (Slack, PagerDuty, Email, Pub/Sub) attached to FinOps spend and waste alerts."
  type        = list(string)
  default     = []
}

variable "enable_finops_bigquery_export" {
  description = "Optional zero-ops FinOps Data Lake: provision a partitioned BigQuery dataset and Cloud Logging sink for apigee-ai-finops SQL chargeback and Looker Studio reporting (off by default)."
  type        = bool
  default     = false
}

variable "developers" {
  description = "Initial enterprise developers to register in Apigee X for quota tracking and FinOps chargeback."
  type = list(object({
    email           = string
    first_name      = string
    last_name       = string
    user_name       = string
    team            = string
    cost_center     = string
    tier            = string # "standard" or "frontier"
    credential_type = optional(string, "user_key")
  }))
  default = [
    {
      email       = "dev-standard@example.com"
      first_name  = "Alex"
      last_name   = "Rivera"
      user_name   = "alex-rivera"
      team        = "platform-engineering"
      cost_center = "CC-1001"
      tier        = "standard"
    },
    {
      email       = "dev-frontier@example.com"
      first_name  = "Sam"
      last_name   = "Chen"
      user_name   = "sam-chen"
      team        = "core-ai-architecture"
      cost_center = "CC-2002"
      tier        = "frontier"
    }
  ]
}

variable "tls_private_key_pem" {
  description = "PEM-encoded private key for the regional HTTPS internal load balancer SSL certificate (used when use_existing_apigee_org = false)."
  type        = string
  default     = ""
  sensitive   = true
}

variable "tls_certificate_pem" {
  description = "PEM-encoded public certificate for the regional HTTPS internal load balancer SSL certificate (used when use_existing_apigee_org = false)."
  type        = string
  default     = ""
}

variable "enable_gemini_decisions_api" {
  description = "Enable the Google Generative Language API (generativelanguage.googleapis.com) and provision the encrypted Apigee environment KVM for the Gemini Decisions API (gemini-decision-1)."
  type        = bool
  default     = false
}

variable "gemini_decisions_kvm_name" {
  description = "Encrypted Apigee X environment KeyValueMap name holding the `gemini_decisions_api_key` entry when DecisionsAuthMode is api_key."
  type        = string
  default     = "switchyard-secrets"
}
