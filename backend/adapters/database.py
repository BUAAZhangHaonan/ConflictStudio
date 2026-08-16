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
        with self.engine.connect() as connection:
            journal_mode = connection.exec_driver_sql("PRAGMA journal_mode=WAL").scalar_one()
        if str(journal_mode).casefold() != "wal":
            raise RuntimeError(f"SQLite WAL mode is required, got: {journal_mode}")
        SQLModel.metadata.create_all(self.engine)
        with self.immediate_session() as session:
            self._initialize_gpu_slots(session)
        with self.engine.begin() as connection:
            self._install_triggers(connection)

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
            ("prompt_template_examples", "prompt template examples are immutable"),
            ("assets", "assets are immutable"),
            ("reviews", "reviews are immutable"),
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
        connection.exec_driver_sql(
            "DROP TRIGGER IF EXISTS prevent_prompt_template_version_content_update"
        )
        connection.exec_driver_sql(
            """
            CREATE TRIGGER prevent_prompt_template_version_content_update
            BEFORE UPDATE ON prompt_template_versions
            WHEN NEW.template_id != OLD.template_id
              OR NEW.version != OLD.version
              OR NEW.organization_instruction != OLD.organization_instruction
              OR NEW.style_instruction != OLD.style_instruction
              OR NEW.ltx_negative_prompt != OLD.ltx_negative_prompt
              OR NEW.h3_negative_prompt != OLD.h3_negative_prompt
              OR NEW.created_at != OLD.created_at
              OR OLD.verification_status != 'Draft'
              OR NEW.verification_status != 'Verified'
              OR NEW.revision != OLD.revision + 1
              OR OLD.verified_at IS NOT NULL
              OR NEW.verified_at IS NULL
            BEGIN
                SELECT RAISE(ABORT, 'prompt template version content is immutable');
            END
            """
        )
        connection.exec_driver_sql(
            "DROP TRIGGER IF EXISTS require_draft_prompt_template_example"
        )
        connection.exec_driver_sql(
            """
            CREATE TRIGGER require_draft_prompt_template_example
            BEFORE INSERT ON prompt_template_examples
            WHEN (
                SELECT verification_status
                FROM prompt_template_versions
                WHERE id = NEW.prompt_template_version_id
            ) != 'Draft'
            BEGIN
                SELECT RAISE(
                    ABORT,
                    'examples can only be added to a draft prompt template version'
                );
            END
            """
        )
        connection.exec_driver_sql(
            "DROP TRIGGER IF EXISTS protect_prompt_template_identity"
        )
        connection.exec_driver_sql(
            """
            CREATE TRIGGER protect_prompt_template_identity
            BEFORE UPDATE ON prompt_templates
            WHEN NEW.category != OLD.category
              OR NEW.created_at != OLD.created_at
              OR NEW.revision != OLD.revision + 1
              OR length(trim(NEW.name)) = 0
              OR length(trim(NEW.name_key)) = 0
            BEGIN
                SELECT RAISE(ABORT, 'prompt template identity update is not allowed');
            END
            """
        )
        connection.exec_driver_sql(
            "DROP TRIGGER IF EXISTS prevent_prompt_template_version_delete"
        )
        connection.exec_driver_sql(
            """
            CREATE TRIGGER prevent_prompt_template_version_delete
            BEFORE DELETE ON prompt_template_versions
            BEGIN
                SELECT RAISE(ABORT, 'prompt template versions are immutable');
            END
            """
        )
        connection.exec_driver_sql(
            "DROP TRIGGER IF EXISTS require_active_content_script_scenes_insert"
        )
        connection.exec_driver_sql(
            "DROP TRIGGER IF EXISTS require_active_content_script_scenes_update"
        )
        for operation in ("INSERT", "UPDATE"):
            connection.exec_driver_sql(
                f"""
                CREATE TRIGGER require_active_content_script_scenes_{operation.casefold()}
                BEFORE {operation} ON content_scripts
                WHEN NEW.status = 'Active'
                  AND NOT (
                    (
                      NEW.mode = 'Fixed'
                      AND 1 = (
                        SELECT count(*)
                        FROM content_script_scenes AS links
                        JOIN scenes ON scenes.id = links.scene_id
                        WHERE links.content_script_id = NEW.id
                          AND scenes.status = 'Active'
                      )
                    )
                    OR (
                      NEW.mode = 'Generative'
                      AND 1 <= (
                        SELECT count(*)
                        FROM content_script_scenes AS links
                        JOIN scenes ON scenes.id = links.scene_id
                        WHERE links.content_script_id = NEW.id
                          AND scenes.status = 'Active'
                      )
                    )
                  )
                BEGIN
                    SELECT RAISE(
                        ABORT,
                        'active content script requires its valid active scenes'
                    );
                END
                """
            )
        connection.exec_driver_sql(
            "DROP TRIGGER IF EXISTS limit_fixed_content_script_scene"
        )
        connection.exec_driver_sql(
            """
            CREATE TRIGGER limit_fixed_content_script_scene
            BEFORE INSERT ON content_script_scenes
            WHEN (
                SELECT mode FROM content_scripts
                WHERE id = NEW.content_script_id
            ) = 'Fixed'
              AND EXISTS (
                SELECT 1 FROM content_script_scenes
                WHERE content_script_id = NEW.content_script_id
              )
            BEGIN
                SELECT RAISE(ABORT, 'fixed content script accepts exactly one scene');
            END
            """
        )
        for operation in ("DELETE", "UPDATE"):
            connection.exec_driver_sql(
                f"DROP TRIGGER IF EXISTS protect_active_content_script_scenes_{operation.casefold()}"
            )
            connection.exec_driver_sql(
                f"""
                CREATE TRIGGER protect_active_content_script_scenes_{operation.casefold()}
                BEFORE {operation} ON content_script_scenes
                WHEN (
                    SELECT status FROM content_scripts
                    WHERE id = OLD.content_script_id
                ) = 'Active'
                BEGIN
                    SELECT RAISE(
                        ABORT,
                        'active content script scene links cannot change'
                    );
                END
                """
            )
        connection.exec_driver_sql(
            "DROP TRIGGER IF EXISTS protect_active_content_script_scene_availability"
        )
        connection.exec_driver_sql(
            """
            CREATE TRIGGER protect_active_content_script_scene_availability
            BEFORE UPDATE OF status ON scenes
            WHEN OLD.status = 'Active'
              AND NEW.status != 'Active'
              AND EXISTS (
                SELECT 1
                FROM content_script_scenes AS current_link
                JOIN content_scripts AS scripts
                  ON scripts.id = current_link.content_script_id
                WHERE current_link.scene_id = OLD.id
                  AND scripts.status = 'Active'
                  AND (
                    scripts.mode = 'Fixed'
                    OR NOT EXISTS (
                      SELECT 1
                      FROM content_script_scenes AS other_link
                      JOIN scenes AS other_scene
                        ON other_scene.id = other_link.scene_id
                      WHERE other_link.content_script_id = scripts.id
                        AND other_link.scene_id != OLD.id
                        AND other_scene.status = 'Active'
                    )
                  )
              )
            BEGIN
                SELECT RAISE(
                    ABORT,
                    'scene is required by an active content script'
                );
            END
            """
        )
        connection.exec_driver_sql("DROP TRIGGER IF EXISTS require_reviews_sample_snapshot")
        connection.exec_driver_sql(
            """
            CREATE TRIGGER require_reviews_sample_snapshot
            BEFORE INSERT ON reviews
            WHEN NOT EXISTS (
                SELECT 1 FROM samples
                WHERE samples.id = NEW.sample_id
                  AND samples.dataset_id = NEW.dataset_id
                  AND NEW.protocol = CASE
                      WHEN samples.category IN ('A-VA', 'C-VA') THEN 'VA'
                      ELSE 'VT'
                  END
                  AND NEW.relation = CASE
                      WHEN samples.category IN ('A-VA', 'A-VT') THEN 'Aligned'
                      ELSE 'Conflict'
                  END
            )
            BEGIN
                SELECT RAISE(ABORT, 'review snapshot must match its sample');
            END
            """
        )
        for operation in ("INSERT", "UPDATE"):
            trigger_name = f"require_archive_items_dataset_{operation.casefold()}"
            connection.exec_driver_sql(f"DROP TRIGGER IF EXISTS {trigger_name}")
            connection.exec_driver_sql(
                f"""
                CREATE TRIGGER {trigger_name}
                BEFORE {operation} ON archive_items
                WHEN NOT EXISTS (
                    SELECT 1 FROM samples
                    WHERE samples.id = NEW.sample_id
                      AND samples.dataset_id = NEW.dataset_id
                )
                BEGIN
                    SELECT RAISE(ABORT, 'archive item dataset must match its sample');
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
        for operation in ("INSERT", "UPDATE"):
            trigger_name = f"protect_job_item_source_{operation.casefold()}"
            connection.exec_driver_sql(f"DROP TRIGGER IF EXISTS {trigger_name}")
            connection.exec_driver_sql(
                f"""
                CREATE TRIGGER {trigger_name}
                BEFORE {operation} ON job_items
                WHEN (
                    (
                        SELECT source FROM jobs WHERE id = NEW.job_id
                    ) = 'PromptTest'
                    AND (
                        NEW.gpu_slot IS NOT NULL
                        OR NEW.renderer_prompt_id IS NOT NULL
                        OR NEW.source_asset_id IS NOT NULL
                        OR NEW.primary_asset_id IS NOT NULL
                    )
                ) OR (
                    (
                        SELECT source FROM jobs WHERE id = NEW.job_id
                    ) IN ('VideoTest', 'Production')
                    AND NEW.gpu_slot IS NULL
                )
                BEGIN
                    SELECT RAISE(ABORT, 'job item resources do not match the job source');
                END
                """
            )
            trigger_name = f"protect_generation_attempt_source_{operation.casefold()}"
            connection.exec_driver_sql(f"DROP TRIGGER IF EXISTS {trigger_name}")
            connection.exec_driver_sql(
                f"""
                CREATE TRIGGER {trigger_name}
                BEFORE {operation} ON generation_attempts
                WHEN (
                    SELECT jobs.source
                    FROM job_items
                    JOIN jobs ON jobs.id = job_items.job_id
                    WHERE job_items.id = NEW.job_item_id
                ) = 'PromptTest'
                BEGIN
                    SELECT RAISE(
                        ABORT,
                        'prompt tests cannot create generation attempts'
                    );
                END
                """
            )
            trigger_name = f"protect_asset_source_{operation.casefold()}"
            connection.exec_driver_sql(f"DROP TRIGGER IF EXISTS {trigger_name}")
            connection.exec_driver_sql(
                f"""
                CREATE TRIGGER {trigger_name}
                BEFORE {operation} ON assets
                WHEN (
                    SELECT jobs.source
                    FROM job_items
                    JOIN jobs ON jobs.id = job_items.job_id
                    WHERE job_items.id = NEW.origin_job_item_id
                ) NOT IN ('VideoTest', 'Production')
                BEGIN
                    SELECT RAISE(
                        ABORT,
                        'assets require a video test or production job item'
                    );
                END
                """
            )
            trigger_name = f"protect_sample_source_{operation.casefold()}"
            connection.exec_driver_sql(f"DROP TRIGGER IF EXISTS {trigger_name}")
            connection.exec_driver_sql(
                f"""
                CREATE TRIGGER {trigger_name}
                BEFORE {operation} ON samples
                WHEN NOT EXISTS (
                    SELECT 1
                    FROM job_items
                    JOIN jobs ON jobs.id = job_items.job_id
                    WHERE job_items.id = NEW.job_item_id
                      AND jobs.source = 'Production'
                      AND jobs.dataset_id = NEW.dataset_id
                      AND job_items.status = 'Completed'
                      AND job_items.primary_asset_id = NEW.primary_asset_id
                      AND (
                        job_items.source_asset_id IS NEW.source_asset_id
                      )
                      AND EXISTS (
                        SELECT 1 FROM assets
                        WHERE assets.id = NEW.primary_asset_id
                          AND assets.origin_job_item_id = NEW.job_item_id
                      )
                      AND (
                        NEW.source_asset_id IS NULL
                        OR EXISTS (
                            SELECT 1 FROM assets
                            WHERE assets.id = NEW.source_asset_id
                              AND assets.origin_job_item_id = NEW.job_item_id
                        )
                      )
                )
                BEGIN
                    SELECT RAISE(
                        ABORT,
                        'samples require completed production media'
                    );
                END
                """
            )
        connection.exec_driver_sql(
            "DROP TRIGGER IF EXISTS protect_job_item_asset_provenance"
        )
        connection.exec_driver_sql(
            """
            CREATE TRIGGER protect_job_item_asset_provenance
            BEFORE UPDATE OF source_asset_id, primary_asset_id ON job_items
            WHEN (
                NEW.source_asset_id IS NOT NULL
                AND NOT EXISTS (
                    SELECT 1 FROM assets
                    WHERE id = NEW.source_asset_id
                      AND origin_job_item_id = NEW.id
                )
            ) OR (
                NEW.primary_asset_id IS NOT NULL
                AND NOT EXISTS (
                    SELECT 1 FROM assets
                    WHERE id = NEW.primary_asset_id
                      AND origin_job_item_id = NEW.id
                )
            )
            BEGIN
                SELECT RAISE(ABORT, 'job item assets must originate from that item');
            END
            """
        )
        connection.exec_driver_sql(
            "DROP TRIGGER IF EXISTS protect_generation_attempt_asset_provenance"
        )
        connection.exec_driver_sql(
            """
            CREATE TRIGGER protect_generation_attempt_asset_provenance
            BEFORE UPDATE OF source_asset_id, primary_asset_id ON generation_attempts
            WHEN (
                NEW.source_asset_id IS NOT NULL
                AND NOT EXISTS (
                    SELECT 1 FROM assets
                    WHERE id = NEW.source_asset_id
                      AND origin_job_item_id = NEW.job_item_id
                )
            ) OR (
                NEW.primary_asset_id IS NOT NULL
                AND NOT EXISTS (
                    SELECT 1 FROM assets
                    WHERE id = NEW.primary_asset_id
                      AND origin_job_item_id = NEW.job_item_id
                )
            )
            BEGIN
                SELECT RAISE(
                    ABORT,
                    'generation attempt assets must originate from that item'
                );
            END
            """
        )
        scene_columns = (
            "scene_en",
            "ambient_sound_en",
            "participant_relationship_en",
            "lighting_en",
            "framing_en",
        )
        scene_text = "lower(" + " || ' ' || ".join(
            f"coalesce(NEW.{column}, '')" for column in scene_columns
        ) + ")"
        forbidden_checks = [
            f"instr({scene_text}, '{phrase.casefold().replace(chr(39), chr(39) * 2)}') > 0"
            for phrase in BACKGROUND_DATABASE_FORBIDDEN_PHRASES
        ]
        forbidden_checks.extend(
            f"lower(trim(coalesce(NEW.{column}, ''))) = '{label.casefold()}'"
            for column in scene_columns
            for label in BANNED_EMOTION_LABELS
        )
        invalid_scene = " OR ".join(forbidden_checks)
        for operation in ("INSERT", "UPDATE"):
            trigger_name = f"reject_scenes_{operation.casefold()}"
            connection.exec_driver_sql(f"DROP TRIGGER IF EXISTS {trigger_name}")
            connection.exec_driver_sql(
                f"""
                CREATE TRIGGER {trigger_name}
                BEFORE {operation} ON scenes
                WHEN {invalid_scene}
                BEGIN
                    SELECT RAISE(ABORT, 'video scene violates prompt policy');
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
