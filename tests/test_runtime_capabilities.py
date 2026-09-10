import json

from sparkscope import runtimes


async def test_endpoint_capabilities_survive_outage_and_counter_reset(monkeypatch):
    responses = {
        "/v1/models": json.dumps({"data": [{"id": "test-model"}]}),
        "/metrics": "vllm:generation_tokens_total 200\nvllm:num_requests_waiting 0",
    }

    async def http(*args):
        return responses.get(args[3])

    monkeypatch.setattr(runtimes, "http_on", http)
    first = await runtimes.collect_service(None, None, "vllm", 8000)
    assert first["metrics"]["requests_waiting"] == 0
    assert "gen_tokens_per_s" in first["supported_metrics"]
    assert "gen_tokens_per_s" not in first["metrics"]  # Requires two polls, not a fabricated zero.
    assert "kv_cache_pct" not in first["supported_metrics"]  # Not exposed by this endpoint.
    responses.clear()
    failed = await runtimes.collect_service(None, None, "vllm", 8000, prev=first)
    assert failed["status"] == "unavailable"
    assert failed["metrics"] == {}
    assert failed["supported_metrics"] == first["supported_metrics"]
    responses.update({"/v1/models": '{"data": []}', "/metrics": "vllm:generation_tokens_total 1"})
    recovered = await runtimes.collect_service(None, None, "vllm", 8000, prev=failed)
    assert "gen_tokens_per_s" in recovered["supported_metrics"]
    assert "gen_tokens_per_s" not in recovered["metrics"]
    assert "requests_waiting" in recovered["supported_metrics"]


async def test_ollama_never_advertises_inference_metrics(monkeypatch):
    async def http(*args):
        return '{"models": []}'

    monkeypatch.setattr(runtimes, "http_on", http)
    result = await runtimes.collect_service(
        None,
        None,
        "ollama",
        11434,
        prev={"metrics": {"requests_waiting": 4}, "supported_metrics": ["requests_waiting"]},
    )
    assert result["metrics"] == {}
    assert result["supported_metrics"] == []
    assert result["status"] == "online"
