-- AllPets VetBuddy — RDS schema
-- Run once on a fresh DB: mysql -h HOST -u USER -p DB_NAME < schema.sql

CREATE TABLE IF NOT EXISTS `allpets_invoices` (
  `invoice_id`      VARCHAR(64)    NOT NULL,
  `invoice_no`      VARCHAR(64)    DEFAULT NULL,
  `clinic_id`       VARCHAR(64)    DEFAULT NULL,
  `clinic_name`     VARCHAR(255)   DEFAULT NULL,
  `client_name`     VARCHAR(255)   DEFAULT NULL,
  `mobile_phone`    VARCHAR(32)    DEFAULT NULL,
  `invoice_date`    DATETIME       NOT NULL,
  `invoice_amount`  DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  `shift`           ENUM('Day','Night') NOT NULL DEFAULT 'Day',
  `cancelled`       TINYINT(1)     NOT NULL DEFAULT 0,
  `synced_at`       TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`invoice_id`),
  KEY `idx_inv_date`           (`invoice_date`),
  KEY `idx_inv_cancelled_date` (`cancelled`, `invoice_date`),
  KEY `idx_inv_clinic`         (`clinic_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `allpets_invoice_items` (
  `id`                     BIGINT        NOT NULL AUTO_INCREMENT,
  `invoice_id`             VARCHAR(64)   NOT NULL,
  `sales_id`               VARCHAR(64)   NOT NULL DEFAULT '',
  `patient_id`             VARCHAR(64)   NOT NULL DEFAULT '',
  `patient_name`           VARCHAR(255)  DEFAULT NULL,
  `patient_species`        VARCHAR(128)  DEFAULT NULL,
  `species_group`          ENUM('Canine','Feline','Others') NOT NULL DEFAULT 'Others',
  `invoice_date`           DATETIME      NOT NULL,
  `plan_category_name`     VARCHAR(255)  DEFAULT NULL,
  `std_category`           VARCHAR(64)   NOT NULL DEFAULT 'Others',
  `plan_sub_category_name` VARCHAR(255)  DEFAULT NULL,
  `item_total`             DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `synced_at`              TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_item`         (`invoice_id`, `sales_id`, `patient_id`),
  KEY `idx_item_date`          (`invoice_date`),
  KEY `idx_item_species`       (`species_group`, `invoice_date`),
  KEY `idx_item_category`      (`std_category`, `invoice_date`),
  KEY `idx_item_patient`       (`patient_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `allpets_payments` (
  `payment_id`        VARCHAR(64)   NOT NULL,
  `invoice_id`        VARCHAR(64)   DEFAULT NULL,
  `payment_date`      DATETIME      DEFAULT NULL,
  `payment_amount`    DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `payment_type_name` VARCHAR(64)   DEFAULT NULL,
  `returned`          TINYINT(1)    NOT NULL DEFAULT 0,
  `synced_at`         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`payment_id`),
  KEY `idx_pay_date`          (`payment_date`),
  KEY `idx_pay_returned_date` (`returned`, `payment_date`),
  KEY `idx_pay_invoice`       (`invoice_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `allpets_stock` (
  `stock_id`               VARCHAR(64)   NOT NULL,
  `clinic_id`              VARCHAR(64)   NOT NULL,
  `clinic_name`            VARCHAR(255)  DEFAULT NULL,
  `stock_name`             VARCHAR(255)  NOT NULL,
  `plan_category_name`     VARCHAR(128)  DEFAULT NULL,
  `plan_sub_category_name` VARCHAR(128)  DEFAULT NULL,
  `std_category`           VARCHAR(64)   DEFAULT NULL,
  `onhand_qty`             DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  `threshold_qty`          DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  `purchase_cost`          DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `stock_status`           ENUM('adequate','low','out','negative') NOT NULL DEFAULT 'adequate',
  PRIMARY KEY (`stock_id`, `clinic_id`),
  KEY `idx_stock_status`  (`stock_status`),
  KEY `idx_stock_std_cat` (`std_category`),
  KEY `idx_stock_clinic`  (`clinic_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `allpets_sync_log` (
  `id`               INT          NOT NULL AUTO_INCREMENT,
  `sync_type`        VARCHAR(32)  NOT NULL DEFAULT 'range',
  `sync_date`        DATE         NOT NULL,
  `started_at`       DATETIME     DEFAULT NULL,
  `completed_at`     DATETIME     DEFAULT NULL,
  `records_upserted` INT          NOT NULL DEFAULT 0,
  `status`           VARCHAR(32)  NOT NULL DEFAULT 'success',
  `error_msg`        TEXT         DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_sync_date` (`sync_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
