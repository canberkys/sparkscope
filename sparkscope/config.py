import os
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_THRESHOLDS = {
    "cpu.temp_max_c": [75, 85],
    "gpu.temp_c": [80, 90],
    "gpu.power_draw_w": [200, None],
    "disk.root_used_pct": [80, 95],
    "memory.used_pct": [90, None],
    "gpu.ecc_uncorrected": [1, 1],
    "gpu.throttle_active": [1, None],
}


@dataclass
class Settings:
    data_dir: Path = field(default_factory=lambda: Path(os.getenv("SPARKSCOPE_DATA_DIR", "~/.sparkscope")).expanduser())
    database_url: str = field(default_factory=lambda: os.getenv("SPARKSCOPE_DATABASE_URL", ""))
    origins: list[str] = field(
        default_factory=lambda: os.getenv(
            "SPARKSCOPE_ORIGINS",
            "http://127.0.0.1:8010,http://localhost:8010,http://127.0.0.1:5178,http://localhost:5178",
        ).split(",")
    )
    secure_cookie: bool = field(default_factory=lambda: os.getenv("SPARKSCOPE_SECURE_COOKIE", "0") == "1")
    collector_enabled: bool = True
    poll_seconds: float = 5
    concurrency: int = 20
    session_hours: int = 12
    key_file: Path | None = None

    def __post_init__(self):
        self.data_dir = Path(self.data_dir).expanduser()
        self.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not self.database_url:
            self.database_url = f"sqlite+aiosqlite:///{self.data_dir / 'fleet.db'}"
        if self.database_url.startswith("postgresql://"):
            self.database_url = self.database_url.replace("postgresql://", "postgresql+asyncpg://", 1)
        self.key_file = Path(
            self.key_file or os.getenv("SPARKSCOPE_KEY_FILE", str(self.data_dir / "master.secret"))
        ).expanduser()
