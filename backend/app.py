from __future__ import annotations

import mimetypes
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response

from backend.adapters.config import Settings
from backend.adapters.database import Database
from backend.adapters.llm import OpenAICompatiblePromptModel, PromptModel
from backend.api.routes import router
from backend.services.batches import BatchService
from backend.services.catalog import CatalogService
from backend.services.errors import ServiceError
from backend.services.prompts import PromptService


def create_app(settings: Settings | None = None, prompt_model: PromptModel | None = None) -> FastAPI:
    resolved_settings = settings or Settings.from_environment()
    database = Database(resolved_settings.data_root)
    database.initialize()
    model = prompt_model or OpenAICompatiblePromptModel.from_environment()

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        yield
        await model.close()

    app = FastAPI(title="ConflictStudio", version="0.1.0", lifespan=lifespan)
    app.state.settings = resolved_settings
    app.state.database = database
    app.state.prompt_model = model
    app.state.catalog_service = CatalogService(database)
    app.state.batch_service = BatchService(database, PromptService(model))

    @app.exception_handler(ServiceError)
    async def service_error_handler(_: Request, error: ServiceError) -> JSONResponse:
        return JSONResponse(
            status_code=error.status_code,
            content={"error": {"code": error.code, "message": error.message, "details": error.details}},
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

    @app.get("/assets/{asset_path:path}", include_in_schema=False)
    def frontend_asset(asset_path: str) -> Response:
        root = (resolved_settings.frontend_dist / "assets").resolve()
        candidate = (root / asset_path).resolve()
        if not candidate.is_relative_to(root) or not candidate.is_file():
            return _error_response(404, "not_found", "The requested file does not exist")
        media_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        return Response(candidate.read_bytes(), media_type=media_type, headers={"Cache-Control": "no-store"})

    @app.get("/{page_path:path}", include_in_schema=False)
    def frontend_page(page_path: str) -> Response:
        if page_path == "api" or page_path.startswith("api/"):
            return _error_response(404, "not_found", "The requested API route does not exist")
        index = resolved_settings.frontend_dist / "index.html"
        if not index.is_file():
            return _error_response(404, "frontend_not_built", "The frontend build is not available")
        return Response(index.read_bytes(), media_type="text/html", headers={"Cache-Control": "no-store"})

    return app


def _error_response(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"error": {"code": code, "message": message, "details": {}}},
    )
