"""CRUD for user-creatable summary templates."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from ..db import get_session
from ..models import SummaryTemplate
from ..security import require_token

router = APIRouter(
    prefix="/api/templates", tags=["templates"], dependencies=[Depends(require_token)]
)


class TemplateIn(BaseModel):
    name: str
    system_prompt: str = ""
    user_prompt_template: str = ""
    output_format: str = "markdown"
    model_override: str | None = None


@router.get("")
def list_templates(session: Session = Depends(get_session)) -> list[SummaryTemplate]:
    return list(session.exec(select(SummaryTemplate).order_by(SummaryTemplate.name)).all())


@router.post("", status_code=201)
def create_template(payload: TemplateIn, session: Session = Depends(get_session)) -> SummaryTemplate:
    tpl = SummaryTemplate(**payload.model_dump(), is_builtin=False)
    session.add(tpl)
    session.commit()
    session.refresh(tpl)
    return tpl


@router.put("/{template_id}")
def update_template(
    template_id: int, payload: TemplateIn, session: Session = Depends(get_session)
) -> SummaryTemplate:
    tpl = session.get(SummaryTemplate, template_id)
    if not tpl:
        raise HTTPException(404, "Vorlage nicht gefunden")
    if tpl.is_builtin:
        raise HTTPException(409, "Eingebaute Vorlagen können nicht bearbeitet werden. Bitte duplizieren.")
    for k, v in payload.model_dump().items():
        setattr(tpl, k, v)
    session.add(tpl)
    session.commit()
    session.refresh(tpl)
    return tpl


@router.post("/{template_id}/duplicate", status_code=201)
def duplicate_template(template_id: int, session: Session = Depends(get_session)) -> SummaryTemplate:
    src = session.get(SummaryTemplate, template_id)
    if not src:
        raise HTTPException(404, "Vorlage nicht gefunden")
    copy = SummaryTemplate(
        name=f"{src.name} (Kopie)",
        system_prompt=src.system_prompt,
        user_prompt_template=src.user_prompt_template,
        output_format=src.output_format,
        model_override=src.model_override,
        is_builtin=False,
    )
    session.add(copy)
    session.commit()
    session.refresh(copy)
    return copy


@router.delete("/{template_id}", status_code=204)
def delete_template(template_id: int, session: Session = Depends(get_session)) -> None:
    tpl = session.get(SummaryTemplate, template_id)
    if not tpl:
        raise HTTPException(404, "Vorlage nicht gefunden")
    if tpl.is_builtin:
        raise HTTPException(409, "Eingebaute Vorlagen können nicht gelöscht werden.")
    session.delete(tpl)
    session.commit()
