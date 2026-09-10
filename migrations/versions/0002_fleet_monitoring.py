"""Persistent monitoring views, event timeline and notifications."""

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("fleet_alerts", sa.Column("component_id", sa.String(100), nullable=True))
    op.create_table(
        "fleet_events",
        sa.Column("notification_processed", sa.Boolean(), nullable=False),
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("device_id", sa.String(36), nullable=False),
        sa.Column("component_id", sa.String(100)),
        sa.Column("kind", sa.String(40), nullable=False),
        sa.Column("ts", sa.Float(), nullable=False),
        sa.Column("detail", sa.JSON(), nullable=False),
    )
    op.create_index("ix_fleet_events_pending", "fleet_events", ["notification_processed", "ts", "id"])
    op.create_index("ix_fleet_events_device_id", "fleet_events", ["device_id"])
    op.create_index("ix_fleet_events_ts", "fleet_events", ["ts"])
    op.create_table(
        "saved_views",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("owner_id", sa.String(36), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("shared", sa.Boolean(), nullable=False),
        sa.Column("config", sa.JSON(), nullable=False),
    )
    op.create_index("ix_saved_views_owner_id", "saved_views", ["owner_id"])
    op.create_table(
        "notification_channels",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("config", sa.JSON(), nullable=False),
        sa.Column("secret", sa.Text(), nullable=False),
    )
    op.create_table(
        "maintenance_windows",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("scope", sa.JSON(), nullable=False),
        sa.Column("start", sa.Float(), nullable=False),
        sa.Column("end", sa.Float(), nullable=False),
        sa.Column("summarized", sa.Boolean(), nullable=False),
    )
    op.create_table(
        "notification_deliveries",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("event_id", sa.String(100), nullable=False),
        sa.Column("channel_id", sa.String(36), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("next_attempt", sa.Float(), nullable=False),
        sa.Column("error", sa.String(200)),
        sa.UniqueConstraint("event_id", "channel_id", name="uq_notification_event_channel"),
    )


def downgrade():
    raise RuntimeError("Restore the matching pre-upgrade database and key backup; destructive downgrade is disabled.")
