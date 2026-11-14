"""
@author: eLeet Coderz (Team 3) - UserProfile: Tyler Gaines; Project/ProjectMember card fields: Saaqib Shaik;
    DashboardWidget: Myoram Langwang; TaskList/Task/Comment/Notification/ProjectMember roles: Aashwat Singh;
    SoftDeadline: Preethi Seereddy; ProjectFinancials/StageCost/Expense/TimeEntry: Jon Sorey
@description: Describes the 13 database tables ProjectForge stores (users, projects, memberships, task
    lists, tasks, soft deadlines, comments, notifications, dashboard widgets, bids/budgets, stage costs,
    expenses, time entries) as Python classes. Passwords and 2FA secrets live ONLY on UserProfile - there
    are no "Login Page", "Sidebar", "templates" or "pages" tables (CWE-256 fix).
@traces: SE-FR-01, SE-FR-02, SE-FR-03, SE-FR-04, SE-FR-06, SE-FR-11, SE-FR-12, SE-FR-13, SE-FR-14, SE-FR-15,
    SE-FR-16, SE-FR-17, SE-FR-21, SE-FR-26, SE-FR-27, SE-FR-28, SE-FR-29, SE-FR-30, SE-NFR-01, SE-NFR-05,
    UC-01..UC-22
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    Date,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import GUID, Base, UTCDateTime, new_id, utcnow

ROLES = ("owner", "manager", "member")
PROJECT_STATUSES = ("planning", "active", "on_hold", "completed", "archived")
PROJECT_TYPES = ("work", "school", "personal")
TASK_STATUSES = ("todo", "in_progress", "review", "done")
TASK_PRIORITIES = ("low", "medium", "high", "urgent")
THEMES = ("light", "dark")
COLOR_BLIND_MODES = ("none", "protanopia", "deuteranopia", "tritanopia", "high_contrast")
EXPENSE_CATEGORIES = ("labor", "materials", "software", "equipment", "travel", "services", "other")
NOTIFICATION_KINDS = (
    "mention",
    "assignment",
    "role_change",
    "member_added",
    "member_removed",
    "deadline_reminder",
    "soft_deadline_reminder",
    "task_reassigned",
    "system",
)

JSONType = JSON().with_variant(JSONB(), "postgresql")
Money = Numeric(12, 2)
Hours = Numeric(8, 2)


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} in ({', '.join(repr(v) for v in values)})"


class UserProfile(Base):
    """Authentication + settings model (User in the Class Diagram)."""

    __tablename__ = "user_profiles"
    __table_args__ = (
        CheckConstraint(_in("theme", THEMES), name="ck_user_profiles_theme"),
        CheckConstraint(_in("color_blind_mode", COLOR_BLIND_MODES), name="ck_user_profiles_cb"),
        CheckConstraint(_in("default_project_type", PROJECT_TYPES), name="ck_user_profiles_ptype"),
        CheckConstraint("failed_login_attempts >= 0", name="ck_user_profiles_failed_attempts"),
    )

    id: Mapped[str] = mapped_column(GUID(), primary_key=True, default=new_id)
    username: Mapped[str] = mapped_column(String(30), unique=True, nullable=False)
    email: Mapped[str] = mapped_column(String(254), unique=True, nullable=False)
    display_name: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    avatar_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    mfa_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    mfa_secret: Mapped[str | None] = mapped_column(String(64), nullable=True)
    failed_login_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    unlock_token_jti: Mapped[str | None] = mapped_column(String(64), nullable=True)
    reset_token_jti: Mapped[str | None] = mapped_column(String(64), nullable=True)
    theme: Mapped[str] = mapped_column(String(10), nullable=False, default="light")
    color_blind_mode: Mapped[str] = mapped_column(String(20), nullable=False, default="none")
    default_project_type: Mapped[str] = mapped_column(String(10), nullable=False, default="work")
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow, onupdate=utcnow)

    memberships: Mapped[list[ProjectMember]] = relationship(back_populates="user", cascade="all, delete-orphan")

    def is_locked(self, now: datetime) -> bool:
        return self.locked_until is not None and self.locked_until > now


# Case-insensitive lookups (login by email/username, bulk member check) stay index-backed: O(log N) each.
Index("ix_user_profiles_username_lower", func.lower(UserProfile.username))
Index("ix_user_profiles_email_lower", func.lower(UserProfile.email))


class Project(Base):
    __tablename__ = "projects"
    __table_args__ = (
        CheckConstraint(_in("status", PROJECT_STATUSES), name="ck_projects_status"),
        CheckConstraint(_in("project_type", PROJECT_TYPES), name="ck_projects_type"),
    )

    id: Mapped[str] = mapped_column(GUID(), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active")
    project_type: Mapped[str] = mapped_column(String(10), nullable=False, default="work")
    deadline: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    created_by: Mapped[str | None] = mapped_column(GUID(), ForeignKey("user_profiles.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow, onupdate=utcnow)

    members: Mapped[list[ProjectMember]] = relationship(back_populates="project", cascade="all, delete-orphan")
    lists: Mapped[list[TaskList]] = relationship(
        back_populates="project", cascade="all, delete-orphan", order_by="TaskList.position"
    )
    tasks: Mapped[list[Task]] = relationship(back_populates="project", cascade="all, delete-orphan")


class ProjectMember(Base):
    """Membership in the Class Diagram: links a user to a project with a role."""

    __tablename__ = "project_members"
    __table_args__ = (
        UniqueConstraint("project_id", "user_id", name="uq_project_members_project_user"),
        CheckConstraint(_in("role", ROLES), name="ck_project_members_role"),
        Index("ix_project_members_user", "user_id"),
        Index("ix_project_members_project_role", "project_id", "role"),
    )

    id: Mapped[str] = mapped_column(GUID(), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(GUID(), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    user_id: Mapped[str] = mapped_column(GUID(), ForeignKey("user_profiles.id", ondelete="CASCADE"), nullable=False)
    role: Mapped[str] = mapped_column(String(10), nullable=False, default="member")
    card_color: Mapped[str] = mapped_column(String(7), nullable=False, default="#6366F1")
    card_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    joined_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)

    project: Mapped[Project] = relationship(back_populates="members")
    user: Mapped[UserProfile] = relationship(back_populates="memberships")

    def can_assign_tasks(self) -> bool:
        """Membership.canAssignTasks() from the Class Diagram."""
        return self.role in ("owner", "manager")


class TaskList(Base):
    __tablename__ = "task_lists"
    __table_args__ = (Index("ix_task_lists_project_position", "project_id", "position"),)

    id: Mapped[str] = mapped_column(GUID(), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(GUID(), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)

    project: Mapped[Project] = relationship(back_populates="lists")


class Task(Base):
    __tablename__ = "tasks"
    __table_args__ = (
        CheckConstraint(_in("status", TASK_STATUSES), name="ck_tasks_status"),
        CheckConstraint(_in("priority", TASK_PRIORITIES), name="ck_tasks_priority"),
        CheckConstraint("estimated_hours is null or estimated_hours >= 0", name="ck_tasks_est"),
        CheckConstraint("assigned_hours is null or assigned_hours >= 0", name="ck_tasks_assigned"),
        Index("ix_tasks_project_status_position", "project_id", "status", "position"),
        Index("ix_tasks_assignee", "assignee_id"),
        Index("ix_tasks_project_due", "project_id", "due_date"),
        Index("ix_tasks_list", "list_id"),
    )

    id: Mapped[str] = mapped_column(GUID(), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(GUID(), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    list_id: Mapped[str | None] = mapped_column(GUID(), ForeignKey("task_lists.id", ondelete="SET NULL"))
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="todo")
    priority: Mapped[str] = mapped_column(String(10), nullable=False, default="medium")
    assignee_id: Mapped[str | None] = mapped_column(GUID(), ForeignKey("user_profiles.id", ondelete="SET NULL"))
    due_date: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    tags: Mapped[list[str]] = mapped_column(JSONType, nullable=False, default=list)
    estimated_hours: Mapped[Decimal | None] = mapped_column(Hours, nullable=True)
    assigned_hours: Mapped[Decimal | None] = mapped_column(Hours, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    created_by: Mapped[str | None] = mapped_column(GUID(), ForeignKey("user_profiles.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow, onupdate=utcnow)

    project: Mapped[Project] = relationship(back_populates="tasks")
    assignee: Mapped[UserProfile | None] = relationship(foreign_keys=[assignee_id])
    soft_deadlines: Mapped[list[SoftDeadline]] = relationship(
        back_populates="task", cascade="all, delete-orphan", order_by="SoftDeadline.due_at"
    )


class SoftDeadline(Base):
    __tablename__ = "soft_deadlines"
    __table_args__ = (
        Index("ix_soft_deadlines_project_due", "project_id", "due_at"),
        Index("ix_soft_deadlines_task_due", "task_id", "due_at"),
    )

    id: Mapped[str] = mapped_column(GUID(), primary_key=True, default=new_id)
    task_id: Mapped[str] = mapped_column(GUID(), ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False)
    project_id: Mapped[str] = mapped_column(GUID(), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    title: Mapped[str] = mapped_column(String(120), nullable=False)
    due_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    is_completed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    created_by: Mapped[str | None] = mapped_column(GUID(), ForeignKey("user_profiles.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow, onupdate=utcnow)

    task: Mapped[Task] = relationship(back_populates="soft_deadlines")


class Comment(Base):
    __tablename__ = "comments"
    __table_args__ = (Index("ix_comments_task_created", "task_id", "created_at"),)

    id: Mapped[str] = mapped_column(GUID(), primary_key=True, default=new_id)
    task_id: Mapped[str] = mapped_column(GUID(), ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False)
    project_id: Mapped[str] = mapped_column(GUID(), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    author_id: Mapped[str | None] = mapped_column(GUID(), ForeignKey("user_profiles.id", ondelete="SET NULL"))
    body: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow, onupdate=utcnow)

    author: Mapped[UserProfile | None] = relationship()


class Notification(Base):
    __tablename__ = "notifications"
    __table_args__ = (
        UniqueConstraint("user_id", "dedupe_key", name="uq_notifications_user_dedupe"),
        CheckConstraint(_in("kind", NOTIFICATION_KINDS), name="ck_notifications_kind"),
        Index("ix_notifications_user_read_created", "user_id", "is_read", "created_at"),
    )

    id: Mapped[str] = mapped_column(GUID(), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(GUID(), ForeignKey("user_profiles.id", ondelete="CASCADE"), nullable=False)
    project_id: Mapped[str | None] = mapped_column(GUID(), ForeignKey("projects.id", ondelete="CASCADE"))
    task_id: Mapped[str | None] = mapped_column(GUID(), ForeignKey("tasks.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(30), nullable=False)
    message: Mapped[str] = mapped_column(String(500), nullable=False)
    link: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    is_read: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    dedupe_key: Mapped[str | None] = mapped_column(String(200), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)


class DashboardWidget(Base):
    __tablename__ = "dashboard_widgets"
    __table_args__ = (
        UniqueConstraint("user_id", "widget_type", name="uq_dashboard_widgets_user_type"),
        CheckConstraint("grid_x >= 0", name="ck_widgets_x"),
        CheckConstraint("grid_y >= 0", name="ck_widgets_y"),
        CheckConstraint("width between 1 and 12", name="ck_widgets_w"),
        CheckConstraint("height between 1 and 12", name="ck_widgets_h"),
    )

    id: Mapped[str] = mapped_column(GUID(), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(GUID(), ForeignKey("user_profiles.id", ondelete="CASCADE"), nullable=False)
    widget_type: Mapped[str] = mapped_column(String(40), nullable=False)
    grid_x: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    grid_y: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    width: Mapped[int] = mapped_column(Integer, nullable=False, default=4)
    height: Mapped[int] = mapped_column(Integer, nullable=False, default=2)
    is_hidden: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow, onupdate=utcnow)

    def overlaps(self, other: DashboardWidget) -> bool:
        """Widget.overlaps(): axis-aligned bounding box intersection."""
        return (
            self.grid_x < other.grid_x + other.width
            and self.grid_x + self.width > other.grid_x
            and self.grid_y < other.grid_y + other.height
            and self.grid_y + self.height > other.grid_y
        )


class ProjectFinancials(Base):
    __tablename__ = "project_financials"
    __table_args__ = (
        CheckConstraint("bid_amount >= 0", name="ck_fin_bid"),
        CheckConstraint("budget_amount >= 0", name="ck_fin_budget"),
    )

    project_id: Mapped[str] = mapped_column(GUID(), ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True)
    bid_amount: Mapped[Decimal] = mapped_column(Money, nullable=False, default=Decimal("0.00"))
    budget_amount: Mapped[Decimal] = mapped_column(Money, nullable=False, default=Decimal("0.00"))
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="USD")
    updated_by: Mapped[str | None] = mapped_column(GUID(), ForeignKey("user_profiles.id", ondelete="SET NULL"))
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow, onupdate=utcnow)


class StageCost(Base):
    __tablename__ = "stage_costs"
    __table_args__ = (
        CheckConstraint("amount >= 0", name="ck_stage_costs_amount"),
        Index("ix_stage_costs_project_position", "project_id", "position"),
    )

    id: Mapped[str] = mapped_column(GUID(), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(GUID(), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    stage_name: Mapped[str] = mapped_column(String(80), nullable=False)
    amount: Mapped[Decimal] = mapped_column(Money, nullable=False, default=Decimal("0.00"))
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    notes: Mapped[str] = mapped_column(Text, nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow, onupdate=utcnow)


class Expense(Base):
    __tablename__ = "expenses"
    __table_args__ = (
        CheckConstraint("amount >= 0", name="ck_expenses_amount"),
        CheckConstraint(_in("category", EXPENSE_CATEGORIES), name="ck_expenses_category"),
        Index("ix_expenses_project_date", "project_id", "expense_date"),
        Index("ix_expenses_project_category", "project_id", "category"),
        Index("ix_expenses_project_amount", "project_id", "amount"),
    )

    id: Mapped[str] = mapped_column(GUID(), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(GUID(), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    stage_cost_id: Mapped[str | None] = mapped_column(GUID(), ForeignKey("stage_costs.id", ondelete="SET NULL"))
    category: Mapped[str] = mapped_column(String(30), nullable=False)
    description: Mapped[str] = mapped_column(String(300), nullable=False)
    amount: Mapped[Decimal] = mapped_column(Money, nullable=False)
    expense_date: Mapped[date] = mapped_column(Date, nullable=False)
    created_by: Mapped[str | None] = mapped_column(GUID(), ForeignKey("user_profiles.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow, onupdate=utcnow)


class TimeEntry(Base):
    __tablename__ = "time_entries"
    __table_args__ = (
        CheckConstraint("source in ('timer', 'manual')", name="ck_time_entries_source"),
        CheckConstraint("paused_seconds >= 0", name="ck_time_entries_paused"),
        Index("ix_time_entries_project_user_started", "project_id", "user_id", "started_at"),
        Index("ix_time_entries_user_ended", "user_id", "ended_at"),
        Index("ix_time_entries_task", "task_id"),
    )

    id: Mapped[str] = mapped_column(GUID(), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(GUID(), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    task_id: Mapped[str] = mapped_column(GUID(), ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False)
    user_id: Mapped[str] = mapped_column(GUID(), ForeignKey("user_profiles.id", ondelete="CASCADE"), nullable=False)
    source: Mapped[str] = mapped_column(String(10), nullable=False, default="timer")
    started_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    ended_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    paused_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    pause_started_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    duration_hours: Mapped[Decimal | None] = mapped_column(Hours, nullable=True)
    note: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)

    task: Mapped[Task] = relationship()
