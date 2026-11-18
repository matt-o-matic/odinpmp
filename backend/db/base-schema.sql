
/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;
DROP TABLE IF EXISTS `audit_log`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `audit_log` (
  `id` char(36) NOT NULL DEFAULT (uuid()),
  `dt_stamp` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `user_id` char(36) NOT NULL,
  `tenant_id` char(36) DEFAULT NULL,
  `project_id` char(36) DEFAULT NULL,
  `ip_addr` varchar(100) NOT NULL,
  `action` varchar(100) NOT NULL,
  `result` varchar(200) NOT NULL,
  `detail` text,
  PRIMARY KEY (`id`),
  KEY `idx_audit_log_user_id` (`user_id`),
  KEY `idx_audit_log_tenant_id` (`tenant_id`),
  KEY `idx_audit_log_project_id` (`project_id`),
  KEY `idx_audit_log_dt_stamp` (`dt_stamp`),
  CONSTRAINT `audit_log_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `audit_log_ibfk_2` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`),
  CONSTRAINT `audit_log_ibfk_3` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `authentication_methods`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `authentication_methods` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(100) NOT NULL,
  `description` text,
  `library` varchar(100) DEFAULT NULL,
  `tenant_id` char(36) DEFAULT NULL,
  `client_id` varchar(255) DEFAULT NULL,
  `client_secret` varchar(255) DEFAULT NULL,
  `redirect_uri` varchar(255) DEFAULT NULL,
  `authorization_endpoint` varchar(255) DEFAULT NULL,
  `token_endpoint` varchar(255) DEFAULT NULL,
  `user_info_endpoint` varchar(255) DEFAULT NULL,
  `scope` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_authentication_methods_tenant_id` (`tenant_id`),
  CONSTRAINT `authentication_methods_ibfk_1` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `backup_codes`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `backup_codes` (
  `id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL,
  `code` varchar(100) NOT NULL,
  `used` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_backup_codes_user_id` (`user_id`),
  KEY `idx_backup_codes_used` (`used`),
  KEY `idx_backup_codes_created_at` (`created_at`),
  CONSTRAINT `backup_codes_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `comment_votes`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `comment_votes` (
  `id` char(36) NOT NULL,
  `comment_id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL,
  `vote` enum('up','down') NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_vote` (`comment_id`,`user_id`),
  KEY `idx_comment_votes_comment_id` (`comment_id`),
  KEY `idx_comment_votes_user_id` (`user_id`),
  KEY `idx_comment_votes_created_at` (`created_at`),
  CONSTRAINT `comment_votes_ibfk_1` FOREIGN KEY (`comment_id`) REFERENCES `comments` (`id`),
  CONSTRAINT `comment_votes_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `comments`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `comments` (
  `id` char(36) NOT NULL,
  `tenant_id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL,
  `target_id` char(36) NOT NULL,
  `target_type` varchar(30) NOT NULL,
  `parent_id` char(36) DEFAULT NULL,
  `comment` longtext NOT NULL,
  `upvotes` int DEFAULT '0',
  `downvotes` int DEFAULT '0',
  `date_added` datetime DEFAULT CURRENT_TIMESTAMP,
  `date_updated` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_comments_tenant_id` (`tenant_id`),
  KEY `idx_comments_user_id` (`user_id`),
  KEY `idx_comments_target_id_type` (`target_id`,`target_type`),
  KEY `idx_comments_parent_id` (`parent_id`),
  KEY `idx_comments_date_added` (`date_added`),
  KEY `idx_comments_date_updated` (`date_updated`),
  CONSTRAINT `comments_ibfk_1` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`),
  CONSTRAINT `comments_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `contributor_metrics`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `contributor_metrics` (
  `id` char(36) NOT NULL DEFAULT (uuid()),
  `tenant_id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL,
  `metric_date` date NOT NULL,
  `tasks_completed` int DEFAULT '0',
  `points_completed` int DEFAULT '0',
  `hours_logged` decimal(5,2) DEFAULT '0.00',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_metric` (`tenant_id`,`user_id`,`metric_date`),
  KEY `user_id` (`user_id`),
  CONSTRAINT `contributor_metrics_ibfk_1` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`),
  CONSTRAINT `contributor_metrics_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `email_bounces`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `email_bounces` (
  `id` int NOT NULL AUTO_INCREMENT,
  `email` varchar(255) NOT NULL,
  `bounce_type` enum('hard','soft') NOT NULL,
  `reason` text,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_email_bounces_email` (`email`),
  KEY `idx_email_bounces_created_at` (`created_at`)
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `email_opt_out`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `email_opt_out` (
  `id` int NOT NULL AUTO_INCREMENT,
  `email` varchar(255) NOT NULL,
  `opted_out` tinyint(1) DEFAULT '0',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`),
  KEY `idx_email_opt_out_opted_out` (`opted_out`),
  KEY `idx_email_opt_out_created_at` (`created_at`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `file_vault`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `file_vault` (
  `id` char(36) NOT NULL,
  `tenant_id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL,
  `target_id` char(36) NOT NULL,
  `target_type` char(30) NOT NULL,
  `file_name` varchar(1024) DEFAULT NULL,
  `file_desc` text,
  `file_type` varchar(100) DEFAULT NULL,
  `file_size` int DEFAULT NULL,
  `file_modified` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `signature` char(32) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_file_vault_tenant_id` (`tenant_id`),
  KEY `idx_file_vault_user_id` (`user_id`),
  KEY `idx_file_vault_target_id_type` (`target_id`,`target_type`),
  KEY `idx_file_vault_file_modified` (`file_modified`),
  KEY `idx_file_vault_created_at` (`created_at`),
  CONSTRAINT `file_vault_ibfk_1` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`),
  CONSTRAINT `file_vault_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `holiday_calendar`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `holiday_calendar` (
  `id` char(36) NOT NULL,
  `calendar_date` date NOT NULL,
  `summary` varchar(255) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_holiday` (`calendar_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `mail_queue`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `mail_queue` (
  `id` int NOT NULL AUTO_INCREMENT,
  `recipient_email` varchar(255) NOT NULL,
  `subject` varchar(255) NOT NULL,
  `body` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  `status` enum('pending','processing','sent','failed') DEFAULT 'pending',
  `attempts` int DEFAULT '0',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `mail_template_id` varchar(36) NOT NULL,
  `mail_target_id` varchar(36) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_mail_queue_status` (`status`),
  KEY `idx_mail_queue_created_at` (`created_at`),
  KEY `mail_queue_mail_templates_FK` (`mail_template_id`),
  CONSTRAINT `mail_queue_mail_templates_FK` FOREIGN KEY (`mail_template_id`) REFERENCES `mail_templates` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=12 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `mail_templates`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `mail_templates` (
  `id` varchar(36) NOT NULL,
  `template_name` varchar(100) NOT NULL,
  `template_contents` varchar(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  `template_styles` text,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `preferences`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `preferences` (
  `id` char(36) NOT NULL,
  `tenant_id` char(36) DEFAULT NULL,
  `user_id` char(36) DEFAULT NULL,
  `project_id` char(36) DEFAULT NULL,
  `key` varchar(50) NOT NULL,
  `value` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_preferences_tenant_id` (`tenant_id`),
  KEY `idx_preferences_user_id` (`user_id`),
  KEY `idx_preferences_project_id` (`project_id`),
  KEY `idx_preferences_key` (`key`),
  CONSTRAINT `preferences_ibfk_1` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`),
  CONSTRAINT `preferences_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `preferences_ibfk_3` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `project_rank_votes`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `project_rank_votes` (
  `id` char(36) NOT NULL,
  `tenant_id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL,
  `project_a` char(36) NOT NULL,
  `project_b` char(36) NOT NULL,
  `winner` char(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `user_id` (`user_id`,`project_a`,`project_b`),
  KEY `tenant_id` (`tenant_id`),
  KEY `project_a` (`project_a`),
  KEY `project_b` (`project_b`),
  KEY `winner` (`winner`),
  CONSTRAINT `project_rank_votes_ibfk_1` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`),
  CONSTRAINT `project_rank_votes_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `project_rank_votes_ibfk_3` FOREIGN KEY (`project_a`) REFERENCES `projects` (`id`),
  CONSTRAINT `project_rank_votes_ibfk_4` FOREIGN KEY (`project_b`) REFERENCES `projects` (`id`),
  CONSTRAINT `project_rank_votes_ibfk_5` FOREIGN KEY (`winner`) REFERENCES `projects` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `project_statuses`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `project_statuses` (
  `id` int NOT NULL AUTO_INCREMENT,
  `project_status_name` varchar(50) DEFAULT NULL,
  `project_status_description` text,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=9 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `projects`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `projects` (
  `id` char(36) NOT NULL,
  `tenant_id` char(36) NOT NULL,
  `name` varchar(255) NOT NULL,
  `description` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci,
  `project_status` int NOT NULL,
  `start_date` date DEFAULT NULL,
  `end_date` date DEFAULT NULL,
  `deleted` int DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `rank` int DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_projects_tenant_id` (`tenant_id`),
  KEY `idx_projects_project_status` (`project_status`),
  KEY `idx_projects_deleted` (`deleted`),
  KEY `idx_projects_start_end_date` (`start_date`,`end_date`),
  KEY `idx_projects_created_at` (`created_at`),
  CONSTRAINT `projects_ibfk_1` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`),
  CONSTRAINT `projects_ibfk_2` FOREIGN KEY (`project_status`) REFERENCES `project_statuses` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `task_log`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `task_log` (
  `id` char(36) NOT NULL,
  `task_id` char(36) NOT NULL,
  `log_date` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `log_action` varchar(50) DEFAULT NULL,
  `log_data` text,
  PRIMARY KEY (`id`),
  KEY `idx_task_log_task_id` (`task_id`),
  KEY `idx_task_log_log_date` (`log_date`),
  CONSTRAINT `task_log_ibfk_1` FOREIGN KEY (`task_id`) REFERENCES `tasks` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `task_statuses`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `task_statuses` (
  `id` char(36) NOT NULL,
  `tenant_id` char(36) DEFAULT NULL,
  `project_id` char(36) DEFAULT NULL,
  `task_status_name` varchar(50) DEFAULT NULL,
  `task_status_description` text,
  `sort_order` int DEFAULT '0',
  `deleted` tinyint(1) DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `idx_task_statuses_tenant_id` (`tenant_id`),
  KEY `idx_task_statuses_project_id` (`project_id`),
  KEY `idx_task_statuses_deleted` (`deleted`),
  KEY `idx_task_statuses_sort_order` (`sort_order`),
  CONSTRAINT `task_statuses_ibfk_1` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`),
  CONSTRAINT `task_statuses_ibfk_2` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `task_types`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `task_types` (
  `id` int NOT NULL AUTO_INCREMENT,
  `tenant_id` char(36) DEFAULT NULL,
  `project_id` char(36) DEFAULT NULL,
  `task_type_name` varchar(50) DEFAULT NULL,
  `task_type_description` text,
  `sort_order` int DEFAULT '0',
  `deleted` tinyint(1) DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `idx_task_types_tenant_id` (`tenant_id`),
  KEY `idx_task_types_project_id` (`project_id`),
  KEY `idx_task_types_deleted` (`deleted`),
  KEY `idx_task_types_sort_order` (`sort_order`),
  CONSTRAINT `task_types_ibfk_1` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`),
  CONSTRAINT `task_types_ibfk_2` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=9 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `tasks`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `tasks` (
  `id` char(36) NOT NULL,
  `project_id` char(36) NOT NULL,
  `task_type` int NOT NULL,
  `parent_task_id` char(36) DEFAULT NULL,
  `name` varchar(255) NOT NULL,
  `description` text,
  `priority` int DEFAULT NULL,
  `points` int DEFAULT NULL,
  `target_start_date` date DEFAULT NULL,
  `target_end_date` date DEFAULT NULL,
  `target_hour_estimate` int DEFAULT NULL,
  `deleted` tinyint DEFAULT '0',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `sort_order` int DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `idx_tasks_project_id` (`project_id`),
  KEY `idx_tasks_task_type` (`task_type`),
  KEY `idx_tasks_parent_task_id` (`parent_task_id`),
  KEY `idx_tasks_deleted` (`deleted`),
  KEY `idx_tasks_start_end_dates` (`target_start_date`,`target_end_date`),
  KEY `idx_tasks_sort_order` (`sort_order`),
  KEY `idx_tasks_created_at` (`created_at`),
  CONSTRAINT `tasks_ibfk_1` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`),
  CONSTRAINT `tasks_ibfk_2` FOREIGN KEY (`task_type`) REFERENCES `task_types` (`id`),
  CONSTRAINT `tasks_ibfk_3` FOREIGN KEY (`parent_task_id`) REFERENCES `tasks` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `tenant_domains`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `tenant_domains` (
  `id` char(36) NOT NULL,
  `tenant_id` char(36) NOT NULL,
  `domain` varchar(255) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `domain` (`domain`),
  KEY `idx_tenant_domains_tenant_id` (`tenant_id`),
  CONSTRAINT `tenant_domains_ibfk_1` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `tenants`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `tenants` (
  `id` char(36) NOT NULL,
  `name` varchar(255) NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_tenants_name` (`name`),
  KEY `idx_tenants_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `tokens`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `tokens` (
  `id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL,
  `token` text NOT NULL,
  `expiry_date` datetime NOT NULL,
  `ip_addr` varchar(100) DEFAULT NULL,
  `location_name` varchar(200) DEFAULT NULL,
  `user_agent` varchar(200) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_tokens_user_id` (`user_id`),
  KEY `idx_tokens_expiry_date` (`expiry_date`),
  CONSTRAINT `tokens_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `user_invites`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `user_invites` (
  `id` char(36) NOT NULL,
  `tenant_id` char(36) NOT NULL,
  `email` varchar(255) NOT NULL,
  `role` varchar(50) NOT NULL,
  `invited_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `accepted` tinyint DEFAULT '0',
  `accepted_at` datetime DEFAULT NULL,
  `invite_token` varchar(255) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `invite_token` (`invite_token`),
  KEY `idx_user_invites_tenant_id` (`tenant_id`),
  KEY `idx_user_invites_accepted` (`accepted`),
  KEY `idx_user_invites_invited_at` (`invited_at`),
  CONSTRAINT `user_invites_ibfk_1` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `user_project`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `user_project` (
  `id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL,
  `project_id` char(36) NOT NULL,
  `role` varchar(50) NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `project_bill_rate` decimal(8,2) DEFAULT NULL,
  `project_allocation` decimal(8,3) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_user_project_user_id` (`user_id`),
  KEY `idx_user_project_project_id` (`project_id`),
  KEY `idx_user_project_created_at` (`created_at`),
  CONSTRAINT `user_project_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `user_project_ibfk_2` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `user_requests`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `user_requests` (
  `id` char(36) NOT NULL,
  `tenant_id` char(36) NOT NULL,
  `name` varchar(255) DEFAULT NULL,
  `email` varchar(255) NOT NULL,
  `requested_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_user_requests_tenant_id` (`tenant_id`),
  KEY `idx_user_requests_requested_at` (`requested_at`),
  CONSTRAINT `user_requests_ibfk_1` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `user_tenant`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `user_tenant` (
  `id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL,
  `tenant_id` char(36) NOT NULL,
  `role` varchar(50) NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `resource_cost` decimal(8,2) DEFAULT NULL,
  `default_bill_rate` decimal(8,2) DEFAULT NULL,
  `min_bill_rate` decimal(8,2) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_user_tenant_user_id` (`user_id`),
  KEY `idx_user_tenant_tenant_id` (`tenant_id`),
  KEY `idx_user_tenant_created_at` (`created_at`),
  CONSTRAINT `user_tenant_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `user_tenant_ibfk_2` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `users`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `users` (
  `id` char(36) NOT NULL,
  `name` varchar(255) NOT NULL,
  `email` varchar(255) NOT NULL,
  `password` varchar(255) DEFAULT NULL,
  `linked_master_user` char(36) DEFAULT NULL,
  `authentication_method_id` int NOT NULL DEFAULT '1',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `first_name` varchar(200) DEFAULT NULL,
  `last_name` varchar(200) DEFAULT NULL,
  `job_title` varchar(255) DEFAULT NULL,
  `department` varchar(255) DEFAULT NULL,
  `bio` longtext,
  `phone` varchar(100) DEFAULT NULL,
  `timezone` varchar(150) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`),
  KEY `idx_users_linked_master_user` (`linked_master_user`),
  KEY `idx_users_auth_method_id` (`authentication_method_id`),
  KEY `idx_users_created_at` (`created_at`),
  CONSTRAINT `users_ibfk_1` FOREIGN KEY (`linked_master_user`) REFERENCES `users` (`id`),
  CONSTRAINT `users_ibfk_2` FOREIGN KEY (`authentication_method_id`) REFERENCES `authentication_methods` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `votes`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `votes` (
  `id` char(36) NOT NULL,
  `project_id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL,
  `priority` int DEFAULT NULL,
  `voted_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_votes_project_id` (`project_id`),
  KEY `idx_votes_user_id` (`user_id`),
  KEY `idx_votes_priority` (`priority`),
  KEY `idx_votes_voted_at` (`voted_at`),
  CONSTRAINT `votes_ibfk_1` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`),
  CONSTRAINT `votes_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `waiting_list`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `waiting_list` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(100) NOT NULL,
  `email` varchar(100) NOT NULL,
  `company` varchar(100) DEFAULT NULL,
  `company_size` varchar(50) DEFAULT NULL,
  `industry` varchar(100) DEFAULT NULL,
  `comments` text,
  `beta_interest` tinyint(1) DEFAULT '0',
  `signup_date` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`),
  KEY `idx_waiting_list_signup_date` (`signup_date`)
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

