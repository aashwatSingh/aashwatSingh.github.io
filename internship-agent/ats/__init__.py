"""Deterministic ATS adapters. Anything not matched here needs the LLM agent."""
from __future__ import annotations

from ats.greenhouse import GreenhouseAdapter

ADAPTERS = {"Greenhouse": GreenhouseAdapter()}

try:                                    # adapters are independent; a broken one must not kill the rest
    from ats.ashby import AshbyAdapter
    ADAPTERS["Ashby"] = AshbyAdapter()
except ImportError:
    pass
try:
    from ats.lever import LeverAdapter
    ADAPTERS["Lever"] = LeverAdapter()
except ImportError:
    pass


try:
    from ats.workday import WorkdayAdapter
    ADAPTERS["Workday"] = WorkdayAdapter()         # experimental past the login screen: opt in with --ats
except ImportError:
    pass

# Portals attempted when --ats is not given. Workday is deliberately not in this list.
DEFAULT_ATS = "Greenhouse,Ashby,Lever"


def adapter_for(url: str):
    for adapter in ADAPTERS.values():
        if adapter.matches(url):
            return adapter
    return None
