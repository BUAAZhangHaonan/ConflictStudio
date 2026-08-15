from __future__ import annotations

from typing import Any, Callable, TypeVar

from sqlalchemy import func
from sqlmodel import Session, select

from backend.domain.schemas import PageRead


PAGE_SIZE = 20
Row = TypeVar("Row")
Item = TypeVar("Item")


def paginate(
    session: Session,
    statement: Any,
    page: int,
    convert: Callable[[Row], Item],
) -> PageRead[Item]:
    total = int(
        session.exec(
            select(func.count()).select_from(statement.order_by(None).subquery())
        ).one()
    )
    rows = session.exec(
        statement.offset((page - 1) * PAGE_SIZE).limit(PAGE_SIZE)
    ).all()
    return PageRead(
        items=[convert(row) for row in rows],
        page=page,
        page_size=PAGE_SIZE,
        total=total,
        total_pages=(total + PAGE_SIZE - 1) // PAGE_SIZE,
    )
