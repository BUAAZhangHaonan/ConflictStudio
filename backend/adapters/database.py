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
from backend.domain.prompt_policy import BANNED_EMOTION_LABELS, BACKGROUND_DATABASE_FORBIDDEN_PHRASES


SQLITE_BUSY_TIMEOUT_MS = 100


class DatabaseBusyError(RuntimeError):
    pass


class Database:
    def __init__(self, data_root: Path) -> None:
        self.data_root = data_root.resolve()
        if not self.data_root.is_dir():
            raise RuntimeError(f"ConflictStudio data root does not exist: {self.data_root}")
        self.database_directory = self.data_root / "database"
        self.database_directory.mkdir(exist_ok=True)
        self.database_path = self.database_directory / "conflictstudio.sqlite3"
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
            self._initialize_gpu_slots(session)
        with self.engine.begin() as connection:
            self._install_triggers(connection)

    def rebuild_empty_generation_tables(self) -> None:
        guarded_tables = (
            "batch_draft_content_plans",
            "batch_draft_prompt_presets",
            "batch_draft_background_presets",
            "batch_draft_demographics",
            "batch_draft_gpu_slots",
            "batch_video_input_snapshots",
            "batch_drafts",
            "job_item_prompt_results",
            "generation_attempts",
            "samples",
            "job_events",
            "job_items",
            "jobs",
            "assets",
        )
        drop_order = (
            "samples",
            "generation_attempts",
            "jobs",
            "batch_video_input_snapshots",
            "batch_drafts",
            "datasets",
            "gpu_slots",
        )
        create_order = (
            "datasets",
            "batch_drafts",
            "batch_video_input_snapshots",
            "jobs",
            "gpu_slots",
            "generation_attempts",
            "samples",
        )

        connection = self.engine.connect()
        transaction_started = False
        try:
            try:
                connection.exec_driver_sql("BEGIN IMMEDIATE")
                transaction_started = True
            except OperationalError as error:
                if self._is_write_lock(error):
                    raise DatabaseBusyError("The database is busy with another write transaction") from error
                raise

            existing_tables = set(
                connection.exec_driver_sql(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                ).scalars()
            )
            occupied_tables = [
                table_name
                for table_name in guarded_tables
                if table_name in existing_tables
                and connection.exec_driver_sql(
                    f'SELECT EXISTS(SELECT 1 FROM "{table_name}" LIMIT 1)'
                ).scalar_one()
            ]
            if occupied_tables:
                names = ", ".join(occupied_tables)
                raise RuntimeError(
                    "Cannot rebuild generation tables while business data exists in: " + names
                )

            for table_name in drop_order:
                if table_name in existing_tables:
                    SQLModel.metadata.tables[table_name].drop(connection)
            for table_name in create_order:
                SQLModel.metadata.tables[table_name].create(connection)

            with Session(bind=connection, expire_on_commit=False) as session:
                self._initialize_gpu_slots(session)
                session.flush()
            self._install_triggers(connection)
            connection.commit()
        except BaseException:
            if transaction_started:
                connection.rollback()
            raise
        finally:
            connection.close()

    @staticmethod
    def _initialize_gpu_slots(session: Session) -> None:
        existing = {row.slot for row in session.exec(select(GpuSlot)).all()}
        for slot in GpuSlotName:
            if slot not in existing:
                session.add(GpuSlot(slot=slot, availability=GpuAvailability.UNKNOWN))

    def _install_triggers(self, connection: Connection) -> None:
        immutable_tables = (
            ("batch_video_input_snapshots", "batch video input snapshots are immutable"),
            ("job_events", "job events are immutable"),
            ("job_item_prompt_results", "job item prompt results are immutable"),
            ("assets", "assets are immutable"),
        )
        quoted_root = str(self.data_root).replace("'", "''")
        connection.exec_driver_sql("DROP TRIGGER IF EXISTS require_assets_storage_root")
        connection.exec_driver_sql(
            f"""
            CREATE TRIGGER require_assets_storage_root
            BEFORE INSERT ON assets
            WHEN NEW.storage_root != '{quoted_root}'
            BEGIN
                SELECT RAISE(ABORT, 'assets must use the configured data root');
            END
            """
        )
        for table_name, message in immutable_tables:
            connection.exec_driver_sql(
                f"""
                CREATE TRIGGER IF NOT EXISTS prevent_{table_name}_update
                BEFORE UPDATE ON {table_name}
                BEGIN
                    SELECT RAISE(ABORT, '{message}');
                END
                """
            )
            connection.exec_driver_sql(
                f"""
                CREATE TRIGGER IF NOT EXISTS prevent_{table_name}_delete
                BEFORE DELETE ON {table_name}
                BEGIN
                    SELECT RAISE(ABORT, '{message}');
                END
                """
            )
        connection.exec_driver_sql("DROP TRIGGER IF EXISTS prevent_generation_attempt_critical_update")
        connection.exec_driver_sql("DROP TRIGGER IF EXISTS prevent_generation_attempt_update")
        connection.exec_driver_sql("DROP TRIGGER IF EXISTS prevent_generation_attempt_delete")
        connection.exec_driver_sql(
            """
            CREATE TRIGGER prevent_generation_attempt_update
            BEFORE UPDATE ON generation_attempts
            WHEN OLD.status != 'Running'
              OR NEW.status NOT IN ('Completed', 'Failed')
              OR NEW.job_item_id != OLD.job_item_id
              OR NEW.attempt_number != OLD.attempt_number
              OR NEW.model != OLD.model
              OR NEW.precision IS NOT OLD.precision
              OR NEW.gpu_slot != OLD.gpu_slot
              OR NEW.seed != OLD.seed
              OR NEW.renderer_prompt_id != OLD.renderer_prompt_id
              OR NEW.started_at != OLD.started_at
            BEGIN
                SELECT RAISE(ABORT, 'generation attempt transition is not allowed');
            END
            """
        )
        connection.exec_driver_sql(
            """
            CREATE TRIGGER prevent_generation_attempt_delete
            BEFORE DELETE ON generation_attempts
            BEGIN
                SELECT RAISE(ABORT, 'generation attempts cannot be deleted');
            END
            """
        )
        background_columns = (
            "scene_en",
            "ambient_sound_en",
            "participant_relationship_en",
            "lighting_en",
            "framing_en",
        )
        background_text = "lower(" + " || ' ' || ".join(
            f"coalesce(NEW.{column}, '')" for column in background_columns
        ) + ")"
        forbidden_checks = [
            f"instr({background_text}, '{phrase.casefold().replace(chr(39), chr(39) * 2)}') > 0"
            for phrase in BACKGROUND_DATABASE_FORBIDDEN_PHRASES
        ]
        forbidden_checks.extend(
            f"lower(trim(coalesce(NEW.{column}, ''))) = '{label.casefold()}'"
            for column in background_columns
            for label in BANNED_EMOTION_LABELS
        )
        invalid_background = " OR ".join(forbidden_checks)
        for operation in ("INSERT", "UPDATE"):
            trigger_name = f"reject_video_background_presets_{operation.casefold()}"
            connection.exec_driver_sql(f"DROP TRIGGER IF EXISTS {trigger_name}")
            connection.exec_driver_sql(
                f"""
                CREATE TRIGGER {trigger_name}
                BEFORE {operation} ON video_background_presets
                WHEN {invalid_background}
                BEGIN
                    SELECT RAISE(ABORT, 'video background preset violates prompt policy');
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
