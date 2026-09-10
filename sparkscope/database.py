from contextlib import asynccontextmanager
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import event
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


class Database:
    def __init__(self, url):
        self.engine = create_async_engine(url, pool_pre_ping=True)
        self.lease = None
        self.file_lease = None
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        if url.startswith("sqlite"):

            @event.listens_for(self.engine.sync_engine, "connect")
            def pragmas(conn, record):
                cursor = conn.cursor()
                cursor.execute("PRAGMA journal_mode=WAL")
                cursor.execute("PRAGMA busy_timeout=10000")
                cursor.execute("PRAGMA foreign_keys=ON")
                cursor.close()

    async def migrate(self):
        def run(conn):
            cfg = Config()
            cfg.set_main_option("script_location", str(Path(__file__).resolve().parent.parent / "migrations"))
            cfg.attributes["connection"] = conn
            command.upgrade(cfg, "head")

        async with self.engine.begin() as conn:
            await conn.run_sync(run)

    @asynccontextmanager
    async def session(self):
        async with self.sessions() as session:
            try:
                yield session
                await session.commit()
            except BaseException:
                await session.rollback()
                raise

    async def acquire_collector(self):
        if self.engine.url.get_backend_name() == "postgresql":
            from sqlalchemy import text

            self.lease = await self.engine.connect()
            result = await self.lease.scalar(text("SELECT pg_try_advisory_lock(831047201)"))
            if not result:
                await self.lease.close()
                self.lease = None
                raise RuntimeError(
                    "Another SparkScope collector already owns this database. Use one application worker."
                )
        else:
            import fcntl

            path = Path(self.engine.url.database).with_suffix(".collector.lock")
            self.file_lease = path.open("a")
            try:
                fcntl.flock(self.file_lease.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                self.file_lease.close()
                self.file_lease = None
                raise RuntimeError("Another SparkScope collector already owns this database.") from None

    async def close(self):
        if self.lease:
            from sqlalchemy import text

            await self.lease.execute(text("SELECT pg_advisory_unlock(831047201)"))
            await self.lease.close()
            self.lease = None
        if self.file_lease:
            self.file_lease.close()
            self.file_lease = None

        await self.engine.dispose()
