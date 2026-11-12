terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# Repositório ECR exclusivo do microsserviço Billing Service
resource "aws_ecr_repository" "billing_service" {
  name                 = "${var.project_name}-billing-service"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }
}

# Banco de Dados Relacional Isolado (PostgreSQL - billing_db) — Database per Service
resource "aws_db_instance" "billing_db" {
  identifier             = "${var.project_name}-billing-db"
  engine                 = "postgres"
  engine_version         = "16.3"
  instance_class         = var.db_instance_class
  allocated_storage      = 20
  db_name                = "billing_db"
  username               = var.db_username
  password               = var.db_password
  skip_final_snapshot    = true
  publicly_accessible    = false
  storage_encrypted      = true
  backup_retention_period = 7

  tags = {
    Project     = var.project_name
    Service     = "billing-service"
    Environment = var.environment
  }
}

output "ecr_repository_url" {
  value       = aws_ecr_repository.billing_service.repository_url
  description = "URL do repositório ECR do Billing Service"
}

output "billing_db_endpoint" {
  value       = aws_db_instance.billing_db.endpoint
  description = "Endpoint do banco PostgreSQL isolado (billing_db)"
}
