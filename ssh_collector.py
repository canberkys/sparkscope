"""Legacy parser import; SSH transport now lives in sparkscope.ssh."""

from sparkscope.parsers import METRIC_COMMAND, MetricParser

SSHPool = MetricParser
__all__ = ["METRIC_COMMAND", "SSHPool"]
