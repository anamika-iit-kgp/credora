# Credora AWS resources, placed inside the VPC created by the Exasol launcher.
# Nothing here is tied to one account or domain: all of it comes from variables.

terraform {
  backend "local" {}
  required_version = ">= 1.8"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
  }
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = {
      Project   = var.project
      Env       = var.env_name
      ManagedBy = "opentofu"
    }
  }
}

data "aws_caller_identity" "me" {}

# --- Network: the Exasol launcher's VPC and public subnet --------------------

data "aws_vpc" "exasol" {
  tags = { Deployment = var.exasol_deployment_tag }
}

data "aws_subnet" "public" {
  vpc_id     = data.aws_vpc.exasol.id
  cidr_block = var.public_subnet_cidr
}

locals {
  name   = "${var.project}-${var.env_name}"
  bucket = "${var.project}-${data.aws_caller_identity.me.account_id}-${var.aws_region}-${var.env_name}"
  # RDS needs a subnet group that spans two availability zones.
  private_subnets = {
    a = { cidr = var.private_subnet_cidrs[0], az = "${var.aws_region}a" }
    b = { cidr = var.private_subnet_cidrs[1], az = "${var.aws_region}b" }
  }
}

resource "aws_subnet" "private" {
  for_each          = local.private_subnets
  vpc_id            = data.aws_vpc.exasol.id
  cidr_block        = each.value.cidr
  availability_zone = each.value.az
  tags              = { Name = "${local.name}-private-${each.key}" }
}

resource "aws_db_subnet_group" "bank" {
  name       = "${local.name}-bank"
  subnet_ids = [for s in aws_subnet.private : s.id]
}

# --- Security groups ---------------------------------------------------------

resource "aws_security_group" "rds" {
  name        = "${local.name}-rds"
  description = "Sapphire Bank databases: reachable from inside the VPC only"
  vpc_id      = data.aws_vpc.exasol.id

  dynamic "ingress" {
    for_each = { 1521 = "Oracle", 3306 = "MySQL", 5432 = "PostgreSQL" }
    content {
      from_port   = ingress.key
      to_port     = ingress.key
      protocol    = "tcp"
      cidr_blocks = [data.aws_vpc.exasol.cidr_block]
      description = ingress.value
    }
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "app" {
  name        = "${local.name}-app"
  description = "Credora web app and mock APIs"
  vpc_id      = data.aws_vpc.exasol.id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "HTTP (redirects to HTTPS)"
  }
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "HTTPS"
  }
  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = concat([var.admin_cidr], var.extra_admin_cidrs)
    description = "SSH for the deployer"
  }
  ingress {
    from_port   = 8100
    to_port     = 8103
    protocol    = "tcp"
    cidr_blocks = [data.aws_vpc.exasol.cidr_block]
    description = "Generator and mock APIs, called by Exasol UDFs"
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# --- Sapphire Bank databases -------------------------------------------------

resource "random_password" "db" {
  for_each = toset(["oracle", "oracle_cbs", "oracle_ro", "mysql", "mysql_ro", "postgres", "postgres_ro", "mockdb", "mock_api", "app_secret",
    "exa_svc", "exa_admin", "exa_datasci", "exa_loanops", "exa_rm", "exa_mcp",
    "exa_admin_ai", "exa_datasci_ai", "exa_loanops_ai", "exa_rm_ai", "exa_rm002"])
  length   = 24
  special  = false
}

resource "aws_db_instance" "oracle" {
  identifier             = "${local.name}-oracle"
  engine                 = "oracle-se2"
  license_model          = "license-included"
  instance_class         = var.oracle_instance
  allocated_storage      = 20
  storage_type           = "gp3"
  db_name                = "SAPPHIRE"
  username               = "credora_admin"
  password               = random_password.db["oracle"].result
  db_subnet_group_name   = aws_db_subnet_group.bank.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false
  multi_az               = false
  skip_final_snapshot    = true
  apply_immediately      = true
  backup_retention_period = 0
  character_set_name     = "AL32UTF8"
}

resource "aws_db_instance" "postgres" {
  identifier              = "${local.name}-postgres"
  engine                  = "postgres"
  engine_version          = var.postgres_version
  instance_class          = var.postgres_instance
  allocated_storage       = 20
  storage_type            = "gp3"
  db_name                 = "credora"
  username                = "credora_admin"
  password                = random_password.db["postgres"].result
  db_subnet_group_name    = aws_db_subnet_group.bank.name
  vpc_security_group_ids  = [aws_security_group.rds.id]
  publicly_accessible     = false
  skip_final_snapshot     = true
  apply_immediately       = true
  backup_retention_period = 0
}

resource "aws_db_instance" "mysql" {
  identifier              = "${local.name}-mysql"
  engine                  = "mysql"
  engine_version          = var.mysql_version
  instance_class          = var.mysql_instance
  allocated_storage       = 20
  storage_type            = "gp3"
  db_name                 = "cif"
  username                = "credora_admin"
  password                = random_password.db["mysql"].result
  db_subnet_group_name    = aws_db_subnet_group.bank.name
  vpc_security_group_ids  = [aws_security_group.rds.id]
  publicly_accessible     = false
  skip_final_snapshot     = true
  apply_immediately       = true
  backup_retention_period = 0
}

# --- S3: model files, ground truth, archive ---------------------------------

resource "aws_s3_bucket" "data" {
  bucket        = local.bucket
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "data" {
  bucket                  = aws_s3_bucket.data.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# --- Secrets: everything the app host needs at runtime -----------------------

resource "aws_secretsmanager_secret" "runtime" {
  name                    = "${local.name}/runtime"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "runtime" {
  secret_id = aws_secretsmanager_secret.runtime.id
  secret_string = jsonencode({
    DOMAIN               = var.domain
    EXTERNAL_DOMAIN      = var.external_domain
    ORACLE_HOST          = aws_db_instance.oracle.address
    ORACLE_PORT          = tostring(aws_db_instance.oracle.port)
    ORACLE_SERVICE       = "SAPPHIRE"
    ORACLE_USER          = "credora_admin"
    ORACLE_PASSWORD      = random_password.db["oracle"].result
    ORACLE_CBS_PASSWORD  = random_password.db["oracle_cbs"].result
    ORACLE_RO_PASSWORD   = random_password.db["oracle_ro"].result
    MYSQL_HOST           = aws_db_instance.mysql.address
    MYSQL_PORT           = tostring(aws_db_instance.mysql.port)
    MYSQL_USER           = "credora_admin"
    MYSQL_PASSWORD       = random_password.db["mysql"].result
    MYSQL_RO_PASSWORD    = random_password.db["mysql_ro"].result
    PG_HOST              = aws_db_instance.postgres.address
    PG_PORT              = tostring(aws_db_instance.postgres.port)
    PG_USER              = "credora_admin"
    PG_PASSWORD          = random_password.db["postgres"].result
    PG_RO_PASSWORD       = random_password.db["postgres_ro"].result
    MOCKDB_PASSWORD      = random_password.db["mockdb"].result
    MOCK_API_TOKEN       = random_password.db["mock_api"].result
    APP_SECRET           = random_password.db["app_secret"].result
    S3_BUCKET            = aws_s3_bucket.data.bucket
    EXASOL_HOST          = var.exasol_private_ip
    EXASOL_PORT          = "8563"
    EXA_SVC_PASSWORD     = random_password.db["exa_svc"].result
    EXA_ADMIN_PASSWORD   = random_password.db["exa_admin"].result
    EXA_DATASCI_PASSWORD = random_password.db["exa_datasci"].result
    EXA_LOANOPS_PASSWORD = random_password.db["exa_loanops"].result
    EXA_RM_PASSWORD      = random_password.db["exa_rm"].result
    EXA_MCP_PASSWORD     = random_password.db["exa_mcp"].result
    # Ask Credora's AI session users, one per person, in consumer group CREDORA_AI.
    EXA_ADMIN_AI_PASSWORD   = random_password.db["exa_admin_ai"].result
    EXA_DATASCI_AI_PASSWORD = random_password.db["exa_datasci_ai"].result
    EXA_LOANOPS_AI_PASSWORD = random_password.db["exa_loanops_ai"].result
    EXA_RM_AI_PASSWORD      = random_password.db["exa_rm_ai"].result
    # A second relationship manager, so the row filter is proven for more than the demo one.
    EXA_RM002_PASSWORD   = random_password.db["exa_rm002"].result
    APP_ADMIN_PASSWORD   = var.app_passwords["admin"]
    APP_DATASCI_PASSWORD = var.app_passwords["datasci"]
    APP_LOANOPS_PASSWORD = var.app_passwords["loanops"]
    APP_RM_PASSWORD      = var.app_passwords["rm"]
    PUBLIC_DEMO          = var.public_demo
    ANTHROPIC_API_KEY    = var.anthropic_api_key
    AI_PROVIDER          = var.ai_provider
    AI_MODEL             = var.ai_model
    BEDROCK_MODEL_ID     = var.bedrock_model_id
  })
}

# --- App host: Caddy, web app, API, mock APIs, generator ---------------------

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }
}

resource "tls_private_key" "app" {
  algorithm = "ED25519"
}

resource "aws_key_pair" "app" {
  key_name   = "${local.name}-app"
  public_key = tls_private_key.app.public_key_openssh
}

resource "local_sensitive_file" "app_key" {
  content         = tls_private_key.app.private_key_openssh
  filename        = "${var.state_dir}/app_key.pem"
  file_permission = "0600"
}

data "aws_iam_policy_document" "assume_ec2" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "app" {
  name               = "${local.name}-app"
  assume_role_policy = data.aws_iam_policy_document.assume_ec2.json
}

data "aws_iam_policy_document" "app" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.runtime.arn]
  }
  statement {
    actions   = ["s3:GetObject", "s3:PutObject", "s3:ListBucket", "s3:DeleteObject"]
    resources = [aws_s3_bucket.data.arn, "${aws_s3_bucket.data.arn}/*"]
  }
  # Claude on Amazon Bedrock for Ask Credora and credit memos (AI_PROVIDER=bedrock).
  statement {
    actions   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "app" {
  role   = aws_iam_role.app.id
  policy = data.aws_iam_policy_document.app.json
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "app" {
  name = "${local.name}-app"
  role = aws_iam_role.app.name
}

resource "aws_instance" "app" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.app_instance
  subnet_id              = data.aws_subnet.public.id
  private_ip             = var.app_private_ip
  vpc_security_group_ids = [aws_security_group.app.id]
  key_name               = aws_key_pair.app.key_name
  iam_instance_profile   = aws_iam_instance_profile.app.name
  user_data              = file("${path.module}/app_user_data.sh")

  root_block_device {
    volume_size = 40
    volume_type = "gp3"
  }
  tags = { Name = "${local.name}-app" }
}

resource "aws_eip" "app" {
  instance = aws_instance.app.id
  domain   = "vpc"
  tags     = { Name = "${local.name}-app" }
}

# --- DNS ---------------------------------------------------------------------
# Bank domain: the web app at the root, plus www, docs, video and ppt.
# 3rd party data APIs domain (optional), the relays to the mock CIBIL, GSTN and Account Aggregator APIs.

data "aws_route53_zone" "site" {
  name         = var.domain
  private_zone = false
}

resource "aws_route53_record" "bank" {
  for_each = toset(["", "www.", "docs.", "video.", "ppt."])
  zone_id  = data.aws_route53_zone.site.zone_id
  name     = "${each.key}${var.domain}"
  type     = "A"
  ttl      = 300
  records  = [aws_eip.app.public_ip]
}

data "aws_route53_zone" "external" {
  count        = var.external_domain == "" ? 0 : 1
  name         = var.external_domain
  private_zone = false
}

resource "aws_route53_record" "external" {
  for_each = var.external_domain == "" ? toset([]) : toset(["", "www.", "cibil.", "gst.", "aa."])
  zone_id  = data.aws_route53_zone.external[0].zone_id
  name     = "${each.key}${var.external_domain}"
  type     = "A"
  ttl      = 300
  records  = [aws_eip.app.public_ip]
}

# Earlier versions had single root and www records; keep them instead of recreating.
moved {
  from = aws_route53_record.root
  to   = aws_route53_record.bank[""]
}

moved {
  from = aws_route53_record.www
  to   = aws_route53_record.bank["www."]
}
