from __future__ import annotations

import mimetypes
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response

from backend.adapters.config import Settings
from backend.adapters.database import Database, DatabaseBusyError
from backend.adapters.llm import OpenAICompatiblePromptModel, PromptModel
from backend.adapters.production_renderer import ProductionRendererGateway
from backend.adapters.renderer import RendererGateway, UnconfiguredRendererGateway
from backend.api.routes import router
from backend.services.assets import AssetService
from backend.services.archives import ArchiveService
from backend.services.batches import BatchService
from backend.services.catalog import CatalogService
from backend.services.errors import ServiceError
from backend.services.job_executor import JobExecutor
from backend.services.prompts import PromptService
from backend.services.reviewers import ReviewerService
from backend.services.reviews import ReviewService
from backend.services.samples import SampleService
from backend.services.statistics import StatisticsService


def create_app(
    settings: Settings | None = None,
    prompt_model: PromptModel | None = None,
    renderer: RendererGateway | None = None,
) -> FastAPI:
    resolved_settings = settings or Settings.from_environment()
    database = Database(resolved_settings.data_root)
    database.initialize()
    model = prompt_model or OpenAICompatiblePromptModel.from_environment()
    renderer_gateway: RendererGateway
    if renderer is not None:
        renderer_gateway = renderer
    elif resolved_settings.renderer is not None:
        renderer_gateway = ProductionRendererGateway.from_settings(
            database,
            resolved_settings.renderer,
        )
    else:
        renderer_gateway = UnconfiguredRendererGateway()
    prompt_service = PromptService(model)
    batch_service = BatchService(database, prompt_service, renderer_gateway)
    job_executor = JobExecutor(database, prompt_service, renderer_gateway)
    if isinstance(renderer_gateway, ProductionRendererGateway):
        renderer_gateway.set_event_notifier(job_executor.notify_events)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        await job_executor.start()
        try:
            yield
        finally:
            await job_executor.stop()
            await renderer_gateway.close()
            await model.close()

    app = FastAPI(title="ConflictStudio", version="0.1.0", lifespan=lifespan)
    app.state.settings = resolved_settings
    app.state.database = database
    app.state.prompt_model = model
    app.state.renderer = renderer_gateway
    app.state.catalog_service = CatalogService(database)
    app.state.asset_service = AssetService(database)
    app.state.batch_service = batch_service
    sample_service = SampleService(database)
    app.state.sample_service = sample_service
    app.state.reviewer_service = ReviewerService(database)
    app.state.review_service = ReviewService(database, sample_service)
    app.state.archive_service = ArchiveService(database)
    app.state.statistics_service = StatisticsService(database)
    app.state.job_executor = job_executor

    @app.exception_handler(ServiceError)
    async def service_error_handler(_: Request, error: ServiceError) -> JSONResponse:
        return JSONResponse(
            status_code=error.status_code,
            content={"error": {"code": error.code, "message": error.message, "details": error.details}},
        )

    @app.exception_handler(DatabaseBusyError)
    async def database_busy_handler(_: Request, error: DatabaseBusyError) -> JSONResponse:
        return JSONResponse(
            status_code=409,
            content={"error": {"code": "database_busy", "message": str(error), "details": {}}},
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(_: Request, error: RequestValidationError) -> JSONResponse:
        fields = [
            {"field": ".".join(str(part) for part in item["loc"] if part != "body"), "message": item["msg"]}
            for item in error.errors()
        ]
        return JSONResponse(
            status_code=422,
            content={
                "error": {
                    "code": "validation_error",
                    "message": "The request data is not valid",
                    "details": {"fields": fields},
                }
            },
        )

    app.include_router(router)

    @app.get("/{page_path:path}", include_in_schema=False)
    def frontend_page(page_path: str) -> Response:
        if page_path == "api" or page_path.startswith("api/"):
            return _error_response(404, "not_found", "The requested API route does not exist")
        root = resolved_settings.frontend_dist.resolve()
        candidate = (root / page_path).resolve()
        if not candidate.is_relative_to(root):
            return _error_response(404, "not_found", "The requested file does not exist")
        if candidate.is_file():
            return _frontend_file_response(candidate)
        if Path(page_path.rsplit("/", 1)[-1]).suffix:
            return _error_response(404, "not_found", "The requested file does not exist")
        index = root / "index.html"
        if not index.is_file():
            return _error_response(404, "frontend_not_built", "The frontend build is not available")
        return _frontend_file_response(index, no_store=True)

    return app


def _error_response(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"error": {"code": code, "message": message, "details": {}}},
    )


def _frontend_file_response(path: Path, *, no_store: bool = False) -> Response:
    media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    headers = {"Cache-Control": "no-store"} if no_store else None
    return Response(path.read_bytes(), media_type=media_type, headers=headers)
