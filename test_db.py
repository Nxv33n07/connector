import mysql.connector
import json
import sys

DB = {
    "host":     "database-2-cohort-sandbox-db.cdokim6aw6op.ap-south-1.rds.amazonaws.com",
    "port":     3306,
    "user":     "cohort_student",
    "password": "AlumnxLearn@2026",
    "database": "cohort_main",
}

try:
    conn = mysql.connector.connect(**DB)
    cursor = conn.cursor(dictionary=True)
    cursor.execute("SELECT COUNT(*) as total_invoices FROM allpets_invoice_items")
    res = cursor.fetchall()
    print(json.dumps(res))
    cursor.close()
    conn.close()
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)
