import glob
import os
import pathlib
import shutil
import subprocess
import time

import psycopg

root = pathlib.Path.cwd()
data = root / ".postgres-data"
socket = pathlib.Path("/tmp/reef-golden-postgres-socket")
log = root / "postgres.log"
postgres_bin = pathlib.Path(sorted(glob.glob("/usr/lib/postgresql/*/bin"))[-1])
initdb = postgres_bin / "initdb"
pg_ctl = postgres_bin / "pg_ctl"

if data.exists():
    shutil.rmtree(data)
socket.mkdir(exist_ok=True)
subprocess.run([
    str(initdb), "-D", str(data), "--auth=trust", "--no-locale", "--encoding=UTF8",
], check=True)
subprocess.run([
    str(pg_ctl), "-D", str(data), "-l", str(log), "-o",
    f"-h '' -k {socket}", "start",
], check=True)

try:
    for _ in range(50):
        try:
            with psycopg.connect(host=str(socket), dbname="postgres"):
                break
        except psycopg.OperationalError:
            time.sleep(0.1)
    migration = (root / "backend/migrations/001_health.sql").read_text(encoding="utf-8")
    with psycopg.connect(host=str(socket), dbname="postgres") as connection:
        connection.execute(migration)
        connection.execute(migration)
        row = connection.execute(
            "SELECT status FROM verification_health WHERE id = 1"
        ).fetchone()
        assert row is not None and row[0] == "ready", repr(row)
finally:
    subprocess.run([str(pg_ctl), "-D", str(data), "stop", "-m", "fast"], check=True)

(root / "migration-result.json").write_text(
    '{"applied":true,"repeatApplied":true,"status":"ready"}\n',
    encoding="utf-8",
)
