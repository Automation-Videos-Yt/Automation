from dataclasses import dataclass
import time

@dataclass
class ProviderMetrics:
    successes: int = 0
    failures: int = 0
    total_latency_ms: int = 0
    cache_hits: int = 0
    daily_cost: float = 0.0

    @property
    def total_calls(self) -> int:
        return self.successes + self.failures

    @property
    def success_rate(self) -> float:
        if self.total_calls == 0:
            return 100.0
        return (self.successes / self.total_calls) * 100.0

    @property
    def avg_latency(self) -> float:
        if self.successes == 0:
            return 0.0
        return self.total_latency_ms / self.successes
        
    @property
    def cache_hit_rate(self) -> float:
        if self.total_calls == 0:
            return 0.0
        return (self.cache_hits / self.total_calls) * 100.0


class ProviderHealth:
    def __init__(self):
        self._metrics: dict[str, ProviderMetrics] = {
            "openai": ProviderMetrics(),
            "gemini": ProviderMetrics()
        }

    def record_result(self, provider: str, success: bool, latency_ms: int = 0, cache_hit: bool = False, cost: float = 0.0):
        if provider not in self._metrics:
            self._metrics[provider] = ProviderMetrics()
            
        m = self._metrics[provider]
        if success:
            m.successes += 1
            m.total_latency_ms += latency_ms
        else:
            m.failures += 1
            
        if cache_hit:
            m.cache_hits += 1
            
        m.daily_cost += cost

    def get_metrics(self, provider: str) -> ProviderMetrics:
        return self._metrics.get(provider, ProviderMetrics())

    def get_healthiest_provider(self, candidates: list[str]) -> str:
        """
        Returns the provider with the best success rate.
        Ties are broken by lowest average latency.
        """
        if not candidates:
            raise ValueError("No candidates provided")
            
        best = candidates[0]
        best_metrics = self.get_metrics(best)
        
        for p in candidates[1:]:
            m = self.get_metrics(p)
            if m.success_rate > best_metrics.success_rate:
                best = p
                best_metrics = m
            elif m.success_rate == best_metrics.success_rate:
                if m.avg_latency < best_metrics.avg_latency:
                    best = p
                    best_metrics = m
                    
        return best

# Singleton
health_monitor = ProviderHealth()
