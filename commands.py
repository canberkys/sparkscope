"""Whitelist command definitions for remote execution."""

COMMANDS = {
    # System
    "uptime": {
        "category": "System",
        "label": "Show Uptime",
        "command": "uptime",
        "destructive": False,
    },
    "check_updates": {
        "category": "System",
        "label": "Check Available Updates",
        "command": "apt list --upgradable 2>/dev/null | tail -n +2",
        "destructive": False,
    },
    "kernel_info": {
        "category": "System",
        "label": "Kernel Info",
        "command": "uname -a && cat /etc/os-release",
        "destructive": False,
    },
    "reboot": {
        "category": "System",
        "label": "Reboot",
        "command": "sudo reboot",
        "destructive": True,
        "confirmation_text": "The device will reboot. Are you sure?",
    },
    "shutdown": {
        "category": "System",
        "label": "Shutdown",
        "command": "sudo shutdown -h now",
        "destructive": True,
        "confirmation_text": "The device will shut down. Are you sure? (You cannot power it back on without physical access.)",
    },

    # GPU
    "nvidia_smi_full": {
        "category": "GPU",
        "label": "nvidia-smi Full Output",
        "command": "nvidia-smi",
        "destructive": False,
    },
    "gpu_processes": {
        "category": "GPU",
        "label": "GPU Processes",
        "command": "nvidia-smi pmon -c 1",
        "destructive": False,
    },
    "gpu_reset": {
        "category": "GPU",
        "label": "Reset GPU",
        "command": "sudo nvidia-smi --gpu-reset -i 0",
        "destructive": True,
        "confirmation_text": "GPU will be reset. Active CUDA processes will crash. Are you sure?",
    },

    # Network
    "interface_status": {
        "category": "Network",
        "label": "Interface Status",
        "command": "ip -br a && echo '---' && ip route",
        "destructive": False,
    },
    "ping_cluster_peer": {
        "category": "Network",
        "label": "Ping Cluster Peer",
        # Cluster peer IP is read from config.yaml (cluster_peer_ip field per host).
        # The dashboard substitutes {peer_ip} at runtime.
        "command": "ping -c 4 {peer_ip}",
        "destructive": False,
    },
    "wifi_quality": {
        "category": "Network",
        "label": "WiFi Signal Quality",
        "command": "iw dev wlP9s9 link",
        "destructive": False,
    },

    # Logs
    "dmesg_tail": {
        "category": "Logs",
        "label": "dmesg (last 50)",
        "command": "dmesg -T | tail -50",
        "destructive": False,
    },
    "journal_errors": {
        "category": "Logs",
        "label": "Journal Errors (last 30)",
        "command": "journalctl -p err -n 30 --no-pager",
        "destructive": False,
    },
    "nvidia_kernel_logs": {
        "category": "Logs",
        "label": "NVIDIA Kernel Messages",
        "command": "dmesg -T | grep -i nvidia | tail -30",
        "destructive": False,
    },

    # Package
    "apt_update": {
        "category": "Package",
        "label": "apt update",
        "command": "sudo apt update",
        "destructive": False,
        "long_running": True,
    },
    "apt_upgrade": {
        "category": "Package",
        "label": "apt upgrade",
        "command": "sudo DEBIAN_FRONTEND=noninteractive apt upgrade -y",
        "destructive": True,
        "confirmation_text": "All packages will be upgraded. This cannot be undone. Are you sure?",
        "long_running": True,
    },
}


def get_commands_grouped() -> dict[str, list[dict]]:
    """Return commands grouped by category."""
    grouped: dict[str, list[dict]] = {}
    for key, cmd in COMMANDS.items():
        cat = cmd["category"]
        if cat not in grouped:
            grouped[cat] = []
        grouped[cat].append({"key": key, **cmd})
    return grouped
