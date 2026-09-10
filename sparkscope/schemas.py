import ipaddress
import re
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

ClusterName = Annotated[str, StringConstraints(strip_whitespace=True, max_length=80)]


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Login(Input):
    username: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=1, max_length=1024)


class Setup(Login):
    token: str = Field(min_length=10, max_length=200)


class UserInput(Login):
    role: Literal["viewer", "operator", "admin"] = "viewer"

    @field_validator("password")
    @classmethod
    def strong(cls, v):
        if len(v) < 12:
            raise ValueError("Use at least 12 characters")
        return v


class UserUpdate(Input):
    role: Literal["viewer", "operator", "admin"]
    active: bool = True
    password: str | None = Field(default=None, min_length=12, max_length=1024)


class Connection(Input):
    address: str = Field(min_length=1, max_length=253)
    port: int = Field(default=22, ge=1, le=65535)
    username: str = Field(min_length=1, max_length=100, pattern=r"^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$")
    auth_type: Literal["password", "key"] = "password"
    password: str = Field(default="", max_length=1024)
    private_key: str = Field(default="", max_length=32768)
    passphrase: str = Field(default="", max_length=1024)
    device_id: str | None = None

    @field_validator("address")
    @classmethod
    def hostname(cls, v):
        v = v.strip().lower()
        try:
            ipaddress.ip_address(v)
            return v
        except ValueError:
            pass
        if not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", v):
            raise ValueError("Enter an IP address or hostname, without a URL or path")
        return v


class Trust(Input):
    fingerprint: str = Field(max_length=200)


class SaveDevice(Input):
    cluster_name: ClusterName = ""
    discovery_id: str
    name: str = Field(min_length=1, max_length=100)
    group: str = Field(default="Default", min_length=1, max_length=100)
    tags: list[str] = Field(default_factory=list, max_length=20)

    @field_validator("tags")
    @classmethod
    def tags_valid(cls, v):
        if any(len(t) > 40 for t in v):
            raise ValueError("Tags must be at most 40 characters")
        return sorted(set(t.strip() for t in v if t.strip()))


class EditDevice(Input):
    cluster_name: ClusterName = ""
    name: str = Field(min_length=1, max_length=100)
    group: str = Field(min_length=1, max_length=100)
    tags: list[str] = Field(default_factory=list, max_length=20)
    paused: bool = False
    archived: bool = False
    cluster_peer_ip: str | None = Field(default=None, max_length=45)

    @field_validator("cluster_peer_ip")
    @classmethod
    def peer(cls, v):
        if v:
            return str(ipaddress.ip_address(v))
        return v

    @field_validator("tags")
    @classmethod
    def tags_valid(cls, v):
        if any(len(t) > 40 for t in v):
            raise ValueError("Tags must be at most 40 characters")
        return sorted({t.strip() for t in v if t.strip()})


class AddService(Input):
    provider: Literal["vllm", "ollama", "llama.cpp"]
    port: int = Field(ge=1, le=65535)
    path: str = Field(default="", max_length=100, pattern=r"^(?:/[a-zA-Z0-9_/-]*)?$")
    api_key: str = Field(default="", max_length=2048)

    @field_validator("api_key")
    @classmethod
    def key_valid(cls, v):
        if "\n" in v or "\r" in v:
            raise ValueError("API keys must be a single line")
        return v


class Operation(Input):
    command: str
    device_ids: list[str] = Field(min_length=1, max_length=50)
    confirmation: str | None = None


class Retention(Input):
    raw_hours: int = Field(default=24, ge=1, le=168)
    minute_days: int = Field(default=7, ge=1, le=90)
    quarter_days: int = Field(default=90, ge=7, le=365)
    event_days: int = Field(default=90, ge=7, le=365)
