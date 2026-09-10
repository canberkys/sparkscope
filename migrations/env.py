from alembic import context

from sparkscope.models import Base

connection = context.config.attributes.get("connection")
if connection is None:
    raise RuntimeError("Use python -m sparkscope.cli migrate")
context.configure(
    connection=connection, target_metadata=Base.metadata, render_as_batch=connection.dialect.name == "sqlite"
)
with context.begin_transaction():
    context.run_migrations()
