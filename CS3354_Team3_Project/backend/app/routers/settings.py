"""
@author: Tyler Gaines
@description: Lets a signed-in user view and change their own profile and preferences: username, display
    name, avatar picture link, light / dark theme, color-blindness palette and the default project type
    (work, school or personal) used when they create new projects.
@traces: SE-FR-12, SE-FR-13, SE-FR-14, SE-FR-15
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import get_current_user
from app.models.entities import UserProfile
from app.schemas.dto import FieldValidationError, ProfileUpdate, UserOut

router = APIRouter(prefix="/api/settings", tags=["settings"])


@router.get("/profile", response_model=UserOut)
def get_profile(user: UserProfile = Depends(get_current_user)) -> UserOut:
    return UserOut.model_validate(user)


@router.put("/profile", response_model=UserOut)
def update_profile(
    body: ProfileUpdate, user: UserProfile = Depends(get_current_user), db: Session = Depends(get_db)
) -> UserOut:
    if body.username is not None and body.username.lower() != user.username.lower():
        taken = db.execute(
            select(UserProfile.id).where(
                func.lower(UserProfile.username) == body.username.lower(), UserProfile.id != user.id
            )
        ).first()
        if taken:
            raise FieldValidationError({"username": "That username is already taken"})
    if body.username is not None:
        user.username = body.username
    if body.display_name is not None:
        user.display_name = body.display_name or user.username
    if body.avatar_url is not None:
        user.avatar_url = body.avatar_url or None
    if body.theme is not None:
        user.theme = body.theme
    if body.color_blind_mode is not None:
        user.color_blind_mode = body.color_blind_mode
    if body.default_project_type is not None:
        user.default_project_type = body.default_project_type
    db.commit()
    db.refresh(user)
    return UserOut.model_validate(user)
