from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from sqlalchemy import event, text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import OperationalError
from sqlmodel import Session, SQLModel, create_engine, select

from backend.domain.enums import GpuAvailability, GpuSlotName
from backend.domain.models import GpuSlot


SQLITE_BUSY_TIMEOUT_MS = 100


class DatabaseBusyError(RuntimeError):
    pass


class Database:
    def __init__(self, data_root: Path) -> None:
        self.data_root = data_root.resolve()
        if not self.data_root.is_dir():
            raise RuntimeError(f"ConflictStudio data root does not exist: {self.data_root}")
        self.database_path = self.data_root / "conflictstudio.sqlite3"
        self.engine = create_engine(
            f"sqlite:///{self.database_path.as_posix()}",
            connect_args={
                "check_same_thread": False,
                "timeout": SQLITE_BUSY_TIMEOUT_MS / 1000,
            },
        )
        self._configure_connections(self.engine)

    @staticmethod
    def _configure_connections(engine: Engine) -> None:
        @event.listens_for(engine, "connect")
        def set_sqlite_pragma(dbapi_connection: object, _: object) -> None:
            cursor = dbapi_connection.cursor()  # type: ignore[attr-defined]
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.execute(f"PRAGMA busy_timeout={SQLITE_BUSY_TIMEOUT_MS}")
            cursor.close()

    def initialize(self) -> None:
        SQLModel.metadata.create_all(self.engine)
        with self.immediate_session() as session:
            existing = {row.slot for row in session.exec(select(GpuSlot)).all()}
            for slot in GpuSlotName:
                if slot not in existing:
                    session.add(GpuSlot(slot=slot, availability=GpuAvailability.UNKNOWN))
        immutable_table = "batch_video_input_snapshots"
        with self.engine.begin() as connection:
            connection.exec_driver_sql(
                f"""
                CREATE TRIGGER IF NOT EXISTS prevent_snapshot_update
                BEFORE UPDATE ON {immutable_table}
                BEGIN
                    SELECT RAISE(ABORT, 'batch video input snapshots are immutable');
                END
                """
            )
            connection.exec_driver_sql(
                f"""
                CREATE TRIGGER IF NOT EXISTS prevent_snapshot_delete
                BEFORE DELETE ON {immutable_table}
                BEGIN
                    SELECT RAISE(ABORT, 'batch video input snapshots are immutable');
                END
                """
            )

    @contextmanager
    def read_session(self) -> Iterator[Session]:
        with Session(self.engine, expire_on_commit=False) as session:
            yield session

    @contextmanager
    def immediate_session(self) -> Iterator[Session]:
        connection: Connection = self.engine.connect()
        transaction_started = False
        try:
            try:
                connection.exec_driver_sql("BEGIN IMMEDIATE")
                transaction_started = True
            except OperationalError as error:
                if self._is_write_lock(error):
                    raise DatabaseBusyError("The database is busy with another write transaction") from error
                raise
            with Session(bind=connection, expire_on_commit=False) as session:
                yield session
                session.flush()
            connection.commit()
        except BaseException:
            if transaction_started:
                connection.rollback()
            raise
        finally:
            connection.close()

    @staticmethod
    def _is_write_lock(error: OperationalError) -> bool:
        original = error.orig
        error_code = getattr(original, "sqlite_errorcode", None)
        base_error_code = error_code & 0xFF if isinstance(error_code, int) else None
        return base_error_code in {sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED} or "locked" in str(original).lower()

    def foreign_keys_enabled(self) -> bool:
        with self.engine.connect() as connection:
            return bool(connection.execute(text("PRAGMA foreign_keys")).scalar_one())
