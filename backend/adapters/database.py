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
            (
                "sample_classification_changes",
                "sample classification changes are immutable",
            ),
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
        for trigger_name in (
            "require_reviews_sample_snapshot",
            "apply_review_to_sample",
            "protect_sample_review_state",
            "validate_sample_classification_change",
            "apply_sample_classification_change",
            "protect_sample_classification",
        ):
            connection.exec_driver_sql(f"DROP TRIGGER IF EXISTS {trigger_name}")
        connection.exec_driver_sql(
            """
            CREATE TRIGGER require_reviews_sample_snapshot
            BEFORE INSERT ON reviews
            WHEN NOT EXISTS (
                SELECT 1
                FROM samples
                WHERE samples.id = NEW.sample_id
                  AND NEW.protocol = CASE
                      WHEN samples.category IN ('A-VA', 'C-VA') THEN 'VA'
                      ELSE 'VT'
                  END
                  AND NEW.relation = CASE
                      WHEN samples.category IN ('A-VA', 'A-VT') THEN 'Aligned'
                      ELSE 'Conflict'
                  END
                  AND NEW.sample_revision = samples.revision
                  AND NEW.revision = samples.review_revision + 1
                  AND NEW.revision = COALESCE(
                      (
                        SELECT max(revision) FROM reviews
                        WHERE reviews.sample_id = NEW.sample_id
                      ),
                      0
                  ) + 1
                  AND (
                      NEW.decision != 'Pending'
                      OR samples.review_decision IN ('Accepted', 'Rejected')
                  )
            )
            BEGIN
                SELECT RAISE(ABORT, 'review snapshot must match its sample');
            END
            """
        )
        connection.exec_driver_sql(
            """
            CREATE TRIGGER apply_review_to_sample
            AFTER INSERT ON reviews
            BEGIN
                UPDATE samples
                SET review_decision = NEW.decision,
                    review_revision = NEW.revision,
                    revision = NEW.sample_revision + 1,
                    updated_at = NEW.created_at
                WHERE id = NEW.sample_id
                  AND revision = NEW.sample_revision
                  AND review_revision = NEW.revision - 1;
                SELECT CASE
                    WHEN changes() != 1
                    THEN RAISE(ABORT, 'review could not update its sample')
                END;
            END
            """
        )
        connection.exec_driver_sql(
            """
            CREATE TRIGGER protect_sample_review_state
            BEFORE UPDATE OF review_decision, review_revision ON samples
            WHEN (
                NEW.review_decision != OLD.review_decision
                OR NEW.review_revision != OLD.review_revision
            )
            AND NOT EXISTS (
                SELECT 1
                FROM reviews
                WHERE reviews.sample_id = OLD.id
                  AND reviews.sample_revision = OLD.revision
                  AND reviews.revision = NEW.review_revision
                  AND reviews.decision = NEW.review_decision
                  AND NEW.review_revision = OLD.review_revision + 1
                  AND NEW.revision = OLD.revision + 1
            )
            AND NOT EXISTS (
                SELECT 1
                FROM sample_classification_changes AS changes
                WHERE changes.sample_id = OLD.id
                  AND changes.before_protocol = CASE
                      WHEN OLD.category IN ('A-VA', 'C-VA') THEN 'VA'
                      ELSE 'VT'
                  END
                  AND changes.after_protocol = CASE
                      WHEN NEW.category IN ('A-VA', 'C-VA') THEN 'VA'
                      ELSE 'VT'
                  END
                  AND changes.before_relation = CASE
                      WHEN OLD.category IN ('A-VA', 'A-VT') THEN 'Aligned'
                      ELSE 'Conflict'
                  END
                  AND changes.after_relation = CASE
                      WHEN NEW.category IN ('A-VA', 'A-VT') THEN 'Aligned'
                      ELSE 'Conflict'
                  END
                  AND changes.before_direction IS OLD.conflict_direction
                  AND changes.after_direction IS NEW.conflict_direction
                  AND changes.before_apparent_emotion = OLD.apparent_emotion
                  AND changes.after_apparent_emotion = NEW.apparent_emotion
                  AND changes.before_true_emotion_description
                      = OLD.true_emotion_description
                  AND changes.after_true_emotion_description
                      = NEW.true_emotion_description
                  AND changes.before_sample_revision = OLD.revision
                  AND changes.after_sample_revision = NEW.revision
                  AND NEW.review_decision = 'Pending'
                  AND NEW.review_revision = OLD.review_revision
            )
            BEGIN
                SELECT RAISE(
                    ABORT,
                    'sample review state requires its append-only review'
                );
            END
            """
        )
        connection.exec_driver_sql(
            """
            CREATE TRIGGER validate_sample_classification_change
            BEFORE INSERT ON sample_classification_changes
            WHEN NOT EXISTS (
                SELECT 1
                FROM samples
                WHERE samples.id = NEW.sample_id
                  AND NEW.before_protocol = CASE
                      WHEN samples.category IN ('A-VA', 'C-VA') THEN 'VA'
                      ELSE 'VT'
                  END
                  AND NEW.before_relation = CASE
                      WHEN samples.category IN ('A-VA', 'A-VT') THEN 'Aligned'
                      ELSE 'Conflict'
                  END
                  AND NEW.before_direction IS samples.conflict_direction
                  AND NEW.before_apparent_emotion = samples.apparent_emotion
                  AND NEW.before_true_emotion_description
                      = samples.true_emotion_description
                  AND NEW.before_sample_revision = samples.revision
                  AND NEW.after_sample_revision = samples.revision + 1
                  AND (
                      NEW.before_protocol != NEW.after_protocol
                      OR NEW.before_relation != NEW.after_relation
                      OR NEW.before_direction IS NOT NEW.after_direction
                      OR NEW.before_apparent_emotion
                          != NEW.after_apparent_emotion
                      OR NEW.before_true_emotion_description
                          != NEW.after_true_emotion_description
                  )
                  AND (
                      (
                        NEW.after_relation = 'Aligned'
                        AND NEW.after_direction IS NULL
                        AND lower(trim(NEW.after_apparent_emotion))
                            = lower(trim(samples.true_emotion))
                      )
                      OR (
                        NEW.after_relation = 'Conflict'
                        AND (
                            (
                              NEW.after_protocol = 'VA'
                              AND NEW.after_direction IN ('Vision', 'Audio')
                            )
                            OR (
                              NEW.after_protocol = 'VT'
                              AND NEW.after_direction IN ('Vision', 'Text')
                            )
                        )
                        AND lower(trim(NEW.after_apparent_emotion))
                            != lower(trim(samples.true_emotion))
                      )
                  )
            )
            BEGIN
                SELECT RAISE(
                    ABORT,
                    'classification history must match its sample transition'
                );
            END
            """
        )
        connection.exec_driver_sql(
            """
            CREATE TRIGGER apply_sample_classification_change
            AFTER INSERT ON sample_classification_changes
            BEGIN
                UPDATE samples
                SET category = CASE
                        WHEN NEW.after_relation = 'Aligned'
                             AND NEW.after_protocol = 'VA' THEN 'A-VA'
                        WHEN NEW.after_relation = 'Aligned'
                             AND NEW.after_protocol = 'VT' THEN 'A-VT'
                        WHEN NEW.after_relation = 'Conflict'
                             AND NEW.after_protocol = 'VA' THEN 'C-VA'
                        ELSE 'C-VT'
                    END,
                    conflict_direction = NEW.after_direction,
                    apparent_emotion = NEW.after_apparent_emotion,
                    true_emotion_description
                        = NEW.after_true_emotion_description,
                    review_decision = 'Pending',
                    revision = NEW.after_sample_revision,
                    updated_at = NEW.created_at
                WHERE id = NEW.sample_id
                  AND revision = NEW.before_sample_revision;
                SELECT CASE
                    WHEN changes() != 1
                    THEN RAISE(
                        ABORT,
                        'classification history could not update its sample'
                    )
                END;
            END
            """
        )
        connection.exec_driver_sql(
            """
            CREATE TRIGGER protect_sample_classification
            BEFORE UPDATE OF
                category,
                conflict_direction,
                apparent_emotion,
                true_emotion_description
            ON samples
            WHEN (
                NEW.category != OLD.category
                OR NEW.conflict_direction IS NOT OLD.conflict_direction
                OR NEW.apparent_emotion != OLD.apparent_emotion
                OR NEW.true_emotion_description
                    != OLD.true_emotion_description
            )
            AND NOT EXISTS (
                SELECT 1
                FROM sample_classification_changes AS changes
                WHERE changes.sample_id = OLD.id
                  AND changes.before_protocol = CASE
                      WHEN OLD.category IN ('A-VA', 'C-VA') THEN 'VA'
                      ELSE 'VT'
                  END
                  AND changes.after_protocol = CASE
                      WHEN NEW.category IN ('A-VA', 'C-VA') THEN 'VA'
                      ELSE 'VT'
                  END
                  AND changes.before_relation = CASE
                      WHEN OLD.category IN ('A-VA', 'A-VT') THEN 'Aligned'
                      ELSE 'Conflict'
                  END
                  AND changes.after_relation = CASE
                      WHEN NEW.category IN ('A-VA', 'A-VT') THEN 'Aligned'
                      ELSE 'Conflict'
                  END
                  AND changes.before_direction IS OLD.conflict_direction
                  AND changes.after_direction IS NEW.conflict_direction
                  AND changes.before_apparent_emotion = OLD.apparent_emotion
                  AND changes.after_apparent_emotion = NEW.apparent_emotion
                  AND changes.before_true_emotion_description
                      = OLD.true_emotion_description
                  AND changes.after_true_emotion_description
                      = NEW.true_emotion_description
                  AND changes.before_sample_revision = OLD.revision
                  AND changes.after_sample_revision = NEW.revision
                  AND NEW.revision = OLD.revision + 1
                  AND NEW.review_decision = 'Pending'
                  AND NEW.review_revision = OLD.review_revision
            )
            BEGIN
                SELECT RAISE(
                    ABORT,
                    'sample classification requires append-only history'
                );
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
            trigger_name = f"require_batch_combination_source_{operation.casefold()}"
            connection.exec_driver_sql(f"DROP TRIGGER IF EXISTS {trigger_name}")
            connection.exec_driver_sql(
                f"""
                CREATE TRIGGER {trigger_name}
                BEFORE {operation} ON batch_draft_combinations
                WHEN NOT EXISTS (
                    SELECT 1
                    FROM batch_drafts
                    JOIN content_scripts
                      ON content_scripts.id = NEW.content_script_id
                    JOIN content_script_scenes
                      ON content_script_scenes.content_script_id = NEW.content_script_id
                     AND content_script_scenes.scene_id = NEW.scene_id
                    JOIN scenes ON scenes.id = NEW.scene_id
                    WHERE batch_drafts.id = NEW.batch_draft_id
                      AND batch_drafts.status = 'Draft'
                      AND content_scripts.category = batch_drafts.category
                      AND content_scripts.conflict_direction IS batch_drafts.conflict_direction
                      AND content_scripts.status = 'Active'
                      AND content_scripts.revision = NEW.content_script_revision
                      AND scenes.status = 'Active'
                      AND scenes.revision = NEW.scene_revision
                )
                BEGIN
                    SELECT RAISE(
                        ABORT,
                        'batch combination must use current compatible active sources'
                    );
                END
                """
            )
        for table_name in (
            "batch_draft_combinations",
            "batch_draft_seeds",
            "batch_draft_prompt_template_versions",
            "batch_draft_gpu_slots",
        ):
            trigger_name = f"protect_submitted_{table_name}_insert"
            connection.exec_driver_sql(f"DROP TRIGGER IF EXISTS {trigger_name}")
            connection.exec_driver_sql(
                f"""
                CREATE TRIGGER {trigger_name}
                BEFORE INSERT ON {table_name}
                WHEN (
                    SELECT status FROM batch_drafts
                    WHERE id = NEW.batch_draft_id
                ) != 'Draft'
                BEGIN
                    SELECT RAISE(ABORT, 'submitted batch inputs are immutable');
                END
                """
            )
            for operation in ("UPDATE", "DELETE"):
                trigger_name = f"protect_submitted_{table_name}_{operation.casefold()}"
                connection.exec_driver_sql(f"DROP TRIGGER IF EXISTS {trigger_name}")
                connection.exec_driver_sql(
                    f"""
                    CREATE TRIGGER {trigger_name}
                    BEFORE {operation} ON {table_name}
                    WHEN (
                        SELECT status FROM batch_drafts
                        WHERE id = OLD.batch_draft_id
                    ) = 'Submitted'
                    BEGIN
                        SELECT RAISE(ABORT, 'submitted batch inputs are immutable');
                    END
                    """
                )
        connection.exec_driver_sql("DROP TRIGGER IF EXISTS require_complete_batch_submit")
        connection.exec_driver_sql(
            """
            CREATE TRIGGER require_complete_batch_submit
            BEFORE UPDATE OF status ON batch_drafts
            WHEN NEW.status = 'Submitted'
              AND (
                OLD.status != 'Draft'
                OR NEW.revision != OLD.revision + 1
                OR NOT EXISTS (
                    SELECT 1 FROM batch_draft_combinations
                    WHERE batch_draft_id = OLD.id
                )
                OR NOT EXISTS (
                    SELECT 1 FROM batch_draft_seeds
                    WHERE batch_draft_id = OLD.id
                )
                OR NOT EXISTS (
                    SELECT 1 FROM batch_draft_prompt_template_versions
                    WHERE batch_draft_id = OLD.id
                )
                OR NOT EXISTS (
                    SELECT 1 FROM batch_draft_gpu_slots
                    WHERE batch_draft_id = OLD.id
                )
                OR NOT EXISTS (
                    SELECT 1
                    FROM datasets
                    WHERE datasets.id = NEW.dataset_id
                      AND datasets.revision = NEW.dataset_revision
                      AND datasets.purpose = 'Formal'
                      AND datasets.status = 'Active'
                )
                OR NOT EXISTS (
                    SELECT 1
                    FROM batch_draft_prompt_template_versions AS selected
                    JOIN prompt_template_versions AS versions
                      ON versions.id = selected.prompt_template_version_id
                    JOIN prompt_templates AS templates
                      ON templates.id = versions.template_id
                    WHERE selected.batch_draft_id = OLD.id
                      AND selected.source_revision = versions.revision
                      AND versions.verification_status = 'Verified'
                      AND templates.category = NEW.category
                )
                OR EXISTS (
                    SELECT 1
                    FROM batch_draft_combinations AS combinations
                    LEFT JOIN content_scripts
                      ON content_scripts.id = combinations.content_script_id
                    LEFT JOIN content_script_scenes AS mappings
                      ON mappings.content_script_id = combinations.content_script_id
                     AND mappings.scene_id = combinations.scene_id
                    LEFT JOIN scenes ON scenes.id = combinations.scene_id
                    WHERE combinations.batch_draft_id = OLD.id
                      AND (
                        content_scripts.id IS NULL
                        OR mappings.id IS NULL
                        OR scenes.id IS NULL
                        OR content_scripts.category != NEW.category
                        OR content_scripts.conflict_direction IS NOT NEW.conflict_direction
                        OR content_scripts.status != 'Active'
                        OR content_scripts.revision != combinations.content_script_revision
                        OR scenes.status != 'Active'
                        OR scenes.revision != combinations.scene_revision
                      )
                )
              )
            BEGIN
                SELECT RAISE(ABORT, 'only a complete draft can be submitted');
            END
            """
        )
        connection.exec_driver_sql("DROP TRIGGER IF EXISTS protect_submitted_batch_draft")
        connection.exec_driver_sql(
            """
            CREATE TRIGGER protect_submitted_batch_draft
            BEFORE UPDATE ON batch_drafts
            WHEN OLD.status = 'Submitted'
            BEGIN
                SELECT RAISE(ABORT, 'submitted batches are immutable');
            END
            """
        )
        connection.exec_driver_sql("DROP TRIGGER IF EXISTS protect_job_ownership")
        connection.exec_driver_sql(
            """
            CREATE TRIGGER protect_job_ownership
            BEFORE UPDATE OF source, dataset_id, dataset_name_snapshot, batch_draft_id ON jobs
            WHEN NEW.source != OLD.source
              OR NEW.dataset_id IS NOT OLD.dataset_id
              OR NEW.dataset_name_snapshot IS NOT OLD.dataset_name_snapshot
              OR NEW.batch_draft_id IS NOT OLD.batch_draft_id
            BEGIN
                SELECT RAISE(ABORT, 'job source and production ownership are immutable');
            END
            """
        )
        for operation in ("INSERT", "UPDATE"):
            trigger_name = f"require_production_job_ownership_{operation.casefold()}"
            connection.exec_driver_sql(f"DROP TRIGGER IF EXISTS {trigger_name}")
            connection.exec_driver_sql(
                f"""
                CREATE TRIGGER {trigger_name}
                BEFORE {operation} ON jobs
                WHEN NEW.source = 'Production'
                  AND NOT EXISTS (
                    SELECT 1
                    FROM batch_drafts
                    JOIN datasets ON datasets.id = batch_drafts.dataset_id
                    WHERE batch_drafts.id = NEW.batch_draft_id
                      AND batch_drafts.status = 'Submitted'
                      AND batch_drafts.dataset_id = NEW.dataset_id
                      AND datasets.name = NEW.dataset_name_snapshot
                      AND batch_drafts.category = NEW.category
                      AND batch_drafts.conflict_direction IS NEW.conflict_direction
                      AND batch_drafts.model = NEW.model
                      AND batch_drafts.precision IS NEW.precision
                  )
                BEGIN
                    SELECT RAISE(
                        ABORT,
                        'production job must match its batch draft and dataset'
                    );
                END
                """
            )
        connection.exec_driver_sql(
            "DROP TRIGGER IF EXISTS protect_referenced_batch_draft_identity"
        )
        connection.exec_driver_sql(
            """
            CREATE TRIGGER protect_referenced_batch_draft_identity
            BEFORE UPDATE OF dataset_id, dataset_revision, category,
                conflict_direction, model, precision ON batch_drafts
            WHEN EXISTS (
                SELECT 1 FROM jobs WHERE jobs.batch_draft_id = OLD.id
            ) AND (
                NEW.dataset_id != OLD.dataset_id
                OR NEW.dataset_revision != OLD.dataset_revision
                OR NEW.category != OLD.category
                OR NEW.conflict_direction IS NOT OLD.conflict_direction
                OR NEW.model != OLD.model
                OR NEW.precision IS NOT OLD.precision
            )
            BEGIN
                SELECT RAISE(
                    ABORT,
                    'referenced batch draft identity is immutable'
                );
            END
            """
        )
        connection.exec_driver_sql("DROP TRIGGER IF EXISTS protect_job_item_parentage")
        connection.exec_driver_sql(
            """
            CREATE TRIGGER protect_job_item_parentage
            BEFORE UPDATE OF job_id, input_snapshot_id ON job_items
            WHEN NEW.job_id != OLD.job_id
              OR NEW.input_snapshot_id != OLD.input_snapshot_id
            BEGIN
                SELECT RAISE(ABORT, 'job item parentage is immutable');
            END
            """
        )
        for operation in ("INSERT", "UPDATE"):
            trigger_name = f"require_job_item_parentage_{operation.casefold()}"
            connection.exec_driver_sql(f"DROP TRIGGER IF EXISTS {trigger_name}")
            connection.exec_driver_sql(
                f"""
                CREATE TRIGGER {trigger_name}
                BEFORE {operation} ON job_items
                WHEN NOT EXISTS (
                    SELECT 1
                    FROM jobs
                    JOIN batch_video_input_snapshots AS snapshots
                      ON snapshots.id = NEW.input_snapshot_id
                    WHERE jobs.id = NEW.job_id
                      AND (
                        (
                          jobs.source = 'Production'
                          AND snapshots.batch_draft_id = jobs.batch_draft_id
                          AND snapshots.dataset_id = jobs.dataset_id
                          AND snapshots.dataset_name = jobs.dataset_name_snapshot
                          AND snapshots.category = jobs.category
                          AND snapshots.conflict_direction IS jobs.conflict_direction
                          AND snapshots.model = jobs.model
                          AND snapshots.precision IS jobs.precision
                        ) OR (
                          jobs.source IN ('PromptTest', 'VideoTest')
                          AND snapshots.batch_draft_id IS NULL
                          AND snapshots.dataset_id IS NULL
                          AND snapshots.category = jobs.category
                          AND snapshots.conflict_direction IS jobs.conflict_direction
                        )
                      )
                )
                BEGIN
                    SELECT RAISE(
                        ABORT,
                        'job item snapshot must match its job source and ownership'
                    );
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
        for trigger_name in (
            "protect_sample_source_insert",
            "protect_sample_source_update",
            "require_sample_dataset_move",
        ):
            connection.exec_driver_sql(f"DROP TRIGGER IF EXISTS {trigger_name}")
        connection.exec_driver_sql(
            """
            CREATE TRIGGER protect_sample_source_insert
            BEFORE INSERT ON samples
            WHEN NOT EXISTS (
                SELECT 1
                FROM job_items
                JOIN jobs ON jobs.id = job_items.job_id
                WHERE job_items.id = NEW.job_item_id
                  AND jobs.source = 'Production'
                  AND jobs.dataset_id = NEW.dataset_id
                  AND job_items.status = 'Completed'
                  AND job_items.primary_asset_id = NEW.primary_asset_id
                  AND job_items.source_asset_id IS NEW.source_asset_id
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
                SELECT RAISE(ABORT, 'samples require completed production media');
            END
            """
        )
        connection.exec_driver_sql(
            """
            CREATE TRIGGER protect_sample_source_update
            BEFORE UPDATE ON samples
            WHEN NOT EXISTS (
                SELECT 1
                FROM job_items
                JOIN jobs ON jobs.id = job_items.job_id
                WHERE job_items.id = NEW.job_item_id
                  AND jobs.source = 'Production'
                  AND job_items.status = 'Completed'
                  AND job_items.primary_asset_id = NEW.primary_asset_id
                  AND job_items.source_asset_id IS NEW.source_asset_id
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
                SELECT RAISE(ABORT, 'samples require completed production media');
            END
            """
        )
        for trigger_name in (
            "validate_dataset_merge_operation_insert",
            "validate_dataset_merge_source_insert",
            "protect_dataset_merge_operation_update",
            "protect_dataset_merge_source_update",
            "validate_dataset_merge_operation_delete",
            "execute_dataset_merge_operation",
            "require_sample_dataset_move",
            "count_sample_dataset_move",
            "apply_dataset_merge_operation",
        ):
            connection.exec_driver_sql(f"DROP TRIGGER IF EXISTS {trigger_name}")
        connection.exec_driver_sql(
            """
            CREATE TRIGGER validate_dataset_merge_operation_insert
            BEFORE INSERT ON dataset_merge_operations
            WHEN NEW.executing != 0
              OR NEW.executed_at IS NOT NULL
              OR NEW.target_revision_before != (
                SELECT revision FROM datasets WHERE id = NEW.target_dataset_id
              )
              OR NOT EXISTS (
                SELECT 1 FROM datasets
                WHERE id = NEW.target_dataset_id
                  AND purpose = 'Formal'
                  AND status = 'Active'
              )
            BEGIN
                SELECT RAISE(
                    ABORT,
                    'dataset merge target must match its expected active revision'
                );
            END
            """
        )
        connection.exec_driver_sql(
            """
            CREATE TRIGGER validate_dataset_merge_source_insert
            BEFORE INSERT ON dataset_merge_sources
            WHEN NOT EXISTS (
                SELECT 1
                FROM dataset_merge_operations AS operations
                JOIN datasets AS sources
                  ON sources.id = NEW.source_dataset_id
                WHERE operations.id = NEW.operation_id
                  AND operations.executing = 0
                  AND NEW.source_dataset_id != operations.target_dataset_id
                  AND sources.revision = NEW.source_revision_before
                  AND NEW.sample_count = (
                    SELECT COUNT(*) FROM samples
                    WHERE dataset_id = NEW.source_dataset_id
                  )
            )
            BEGIN
                SELECT RAISE(
                    ABORT,
                    'dataset merge source must match its expected revision and samples'
                );
            END
            """
        )
        connection.exec_driver_sql(
            """
            CREATE TRIGGER protect_dataset_merge_source_update
            BEFORE UPDATE ON dataset_merge_sources
            BEGIN
                SELECT RAISE(ABORT, 'dataset merge sources are immutable');
            END
            """
        )
        connection.exec_driver_sql(
            """
            CREATE TRIGGER execute_dataset_merge_operation
            BEFORE UPDATE ON dataset_merge_operations
            WHEN NOT (
                OLD.executing = 0
                AND NEW.executing = 1
                AND OLD.executed_at IS NULL
                AND NEW.executed_at IS NOT NULL
                AND NEW.id = OLD.id
                AND NEW.target_dataset_id = OLD.target_dataset_id
                AND NEW.target_revision_before = OLD.target_revision_before
                AND NEW.source_count = OLD.source_count
                AND NEW.source_count = (
                    SELECT COUNT(*) FROM dataset_merge_sources
                    WHERE operation_id = OLD.id
                )
                AND EXISTS (
                    SELECT 1 FROM datasets
                    WHERE id = NEW.target_dataset_id
                      AND revision = NEW.target_revision_before
                      AND purpose = 'Formal'
                      AND status = 'Active'
                )
                AND NOT EXISTS (
                    SELECT 1
                    FROM dataset_merge_sources AS selected
                    LEFT JOIN datasets AS sources
                      ON sources.id = selected.source_dataset_id
                    WHERE selected.operation_id = OLD.id
                      AND (
                        sources.id IS NULL
                        OR sources.revision != selected.source_revision_before
                        OR selected.sample_count != (
                            SELECT COUNT(*) FROM samples
                            WHERE dataset_id = selected.source_dataset_id
                        )
                      )
                )
            )
            BEGIN
                SELECT RAISE(
                    ABORT,
                    'dataset merge revisions or source samples changed'
                );
            END
            """
        )
        connection.exec_driver_sql(
            """
            CREATE TRIGGER require_sample_dataset_move
            BEFORE UPDATE OF dataset_id ON samples
            WHEN NEW.dataset_id != OLD.dataset_id
              AND NOT EXISTS (
                SELECT 1
                FROM dataset_merge_operations AS operations
                JOIN dataset_merge_sources AS selected
                  ON selected.operation_id = operations.id
                 AND selected.source_dataset_id = OLD.dataset_id
                JOIN datasets AS sources
                  ON sources.id = selected.source_dataset_id
                JOIN datasets AS targets
                  ON targets.id = operations.target_dataset_id
                WHERE operations.executing = 1
                  AND operations.target_dataset_id = NEW.dataset_id
                  AND sources.revision = selected.source_revision_before + 1
                  AND targets.revision = operations.target_revision_before + 1
                  AND NEW.revision = OLD.revision + 1
              )
            BEGIN
                SELECT RAISE(
                    ABORT,
                    'sample dataset moves require both dataset revisions in one merge transaction'
                );
            END
            """
        )
        connection.exec_driver_sql(
            """
            CREATE TRIGGER apply_dataset_merge_operation
            AFTER UPDATE OF executing ON dataset_merge_operations
            WHEN OLD.executing = 0 AND NEW.executing = 1
            BEGIN
                UPDATE datasets
                SET revision = revision + 1, updated_at = NEW.executed_at
                WHERE id = NEW.target_dataset_id;

                UPDATE datasets
                SET revision = revision + 1, updated_at = NEW.executed_at
                WHERE id IN (
                    SELECT source_dataset_id
                    FROM dataset_merge_sources
                    WHERE operation_id = NEW.id
                );

                UPDATE samples
                SET dataset_id = NEW.target_dataset_id,
                    revision = revision + 1,
                    updated_at = NEW.executed_at
                WHERE dataset_id IN (
                    SELECT source_dataset_id
                    FROM dataset_merge_sources
                    WHERE operation_id = NEW.id
                );

                DELETE FROM dataset_merge_sources
                WHERE operation_id = NEW.id;
                DELETE FROM dataset_merge_operations
                WHERE id = NEW.id;
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
