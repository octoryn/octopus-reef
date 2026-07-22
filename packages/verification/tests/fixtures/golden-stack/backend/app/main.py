import os

import psycopg
from fastapi import FastAPI

app = FastAPI(title="Reef Verification Golden Stack")


@app.get("/health")
def health() -> dict[str, str]:
    database_url = os.environ.get("DATABASE_URL")
    if database_url:
        with psycopg.connect(database_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT status FROM verification_health WHERE id = 1")
                status = cursor.fetchone()[0]
    else:
        status = "test"
    return {"status": status, "component": "backend"}
