variable "project" {
  type    = string
  default = "credora"
}

variable "env_name" {
  description = "Deployment name, e.g. credora. Matches the .env.<name> file."
  type        = string
}

variable "aws_region" {
  type = string
}

variable "domain" {
  description = "Route 53 hosted zone in this account; the site runs at its root."
  type        = string
}

variable "external_domain" {
  description = "Optional second Route 53 zone for the 3rd party data APIs, with cibil., gst. and aa. relays to the mock CIBIL, GSTN and Account Aggregator APIs."
  type        = string
  default     = ""
}

variable "admin_cidr" {
  description = "Deployer IP/32, allowed to SSH to the app host."
  type        = string
}

variable "extra_admin_cidrs" {
  description = "More IP ranges allowed to SSH to the app host (e.g. a second laptop), added with `credora.py allow-ip`."
  type        = list(string)
  default     = []
}

variable "exasol_deployment_tag" {
  description = "Deployment tag of the Exasol launcher's VPC, e.g. exasol-c6ca6046."
  type        = string
}

variable "public_subnet_cidr" {
  type    = string
  default = "172.30.1.0/24"
}

variable "private_subnet_cidrs" {
  type    = list(string)
  default = ["172.30.2.0/24", "172.30.3.0/24"]
}

variable "app_private_ip" {
  description = "Fixed private IP of the app host, so Exasol UDFs can reach the mock APIs."
  type        = string
  default     = "172.30.1.20"
}

variable "app_instance" {
  type    = string
  default = "t3.large"
}

variable "oracle_instance" {
  type    = string
  default = "db.t3.small"
}

variable "postgres_instance" {
  type    = string
  default = "db.t4g.micro"
}

variable "postgres_version" {
  type    = string
  default = "16"
}

variable "mysql_instance" {
  type    = string
  default = "db.t4g.micro"
}

variable "mysql_version" {
  type    = string
  default = "8.4"
}

variable "state_dir" {
  description = "Local folder for this deployment's generated files (never committed)."
  type        = string
}

variable "exasol_private_ip" {
  description = "Private IP of the Exasol node (the launcher's first node)."
  type        = string
  default     = "172.30.1.11"
}

variable "app_passwords" {
  description = "Web app demo logins per role. Shown to judges on purpose: all data is synthetic."
  type        = map(string)
  default = {
    admin   = "Demo@123"
    datasci = "Demo@123"
    loanops = "Demo@123"
    rm      = "Demo@123"
  }
}

variable "ai_provider" {
  description = "anthropic (Claude API key) or bedrock (Amazon Bedrock in this account). Empty disables AI features."
  type        = string
  default     = ""
}

variable "anthropic_api_key" {
  type      = string
  default   = ""
  sensitive = true
}

variable "ai_model" {
  type    = string
  default = "claude-sonnet-5-5"
}
