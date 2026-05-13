-- AllPets VetBuddy — RDS schema bootstrap
-- Run once on a fresh DB: mysql -h HOST -u USER -p DB_NAME < schema.sql

CREATE TABLE IF NOT EXISTS `allpets_invoices` (
  `invoice_id`    VARCHAR(64)    NOT NULL,
  `invoice_date`  DATETIME       NOT NULL,
  `invoice_amount` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `shift`         ENUM('Day','Night') NOT NULL DEFAULT 'Day',
  `cancelled`     TINYINT(1)     NOT NULL DEFAULT 0,
  `is_new_client` TINYINT(1)     NOT NULL DEFAULT 0,
  `client_id`     VARCHAR(64)    DEFAULT NULL,
  PRIMARY KEY (`invoice_id`),
  KEY `idx_inv_date`          (`invoice_date`),
  KEY `idx_inv_cancelled_date` (`cancelled`, `invoice_date`),
  KEY `idx_inv_client`        (`client_id`),
  KEY `idx_inv_new_client`    (`is_new_client`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `allpets_invoice_items` (
  `invoice_id`             VARCHAR(64)  NOT NULL,
  `invoice_date`           DATETIME     NOT NULL,
  `item_total`             DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `species_group`          ENUM('Canine','Feline','Others') NOT NULL DEFAULT 'Others',
  `std_category`           VARCHAR(64)  NOT NULL DEFAULT 'Others',
  `plan_sub_category_name` VARCHAR(255) DEFAULT NULL,
  `sales_id`               VARCHAR(64)  NOT NULL DEFAULT '',
  `patient_id`             VARCHAR(64)  NOT NULL DEFAULT '',
  UNIQUE KEY `uk_item`      (`invoice_id`, `sales_id`, `patient_id`),
  KEY `idx_item_date`       (`invoice_date`),
  KEY `idx_item_species`    (`species_group`, `invoice_date`),
  KEY `idx_item_category`   (`std_category`, `invoice_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `allpets_payments` (
  `payment_id`        VARCHAR(64)   NOT NULL,
  `clinic_id`         VARCHAR(64)   DEFAULT NULL,
  `client_id`         VARCHAR(64)   DEFAULT NULL,
  `invoice_id`        VARCHAR(64)   DEFAULT NULL,
  `payment_date`      DATETIME      DEFAULT NULL,
  `payment_amount`    DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `payment_type_name` VARCHAR(64)   DEFAULT NULL,
  `returned`          TINYINT(1)    NOT NULL DEFAULT 0,
  PRIMARY KEY (`payment_id`),
  KEY `idx_pay_date`          (`payment_date`),
  KEY `idx_pay_returned_date` (`returned`, `payment_date`)
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
  KEY `idx_stock_status`   (`stock_status`),
  KEY `idx_stock_std_cat`  (`std_category`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `allpets_sync_log` (
  `sync_date`     DATE        NOT NULL,
  `synced_at`     DATETIME    NOT NULL,
  `status`        VARCHAR(32) NOT NULL DEFAULT 'success',
  `records_count` INT         NOT NULL DEFAULT 0,
  PRIMARY KEY (`sync_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
