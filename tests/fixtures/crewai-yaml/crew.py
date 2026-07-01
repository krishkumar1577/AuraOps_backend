"""
YAML-defined crew fixture: agents=[] declared in crew.yaml, not crew.py.
Detector should find agents in either source. This tests the path where
the agent list lives outside a .py file (common in CrewAI tutorials).
"""

from crewai import Agent, Crew, Task
from crewai import agent as _agent_module  # not used, just to keep import varied
from langchain_community.tools import DuckDuckGoSearchRun, WikipediaQueryRun

import yaml
from pathlib import Path


# Tool 1
search = DuckDuckGoSearchRun()
# Tool 2
wiki = WikipediaQueryRun()

# Agents are loaded from crew.yaml
yaml_path = Path(__file__).parent / "crew.yaml"
config = yaml.safe_load(yaml_path.read_text())
agent_specs = config["agents"]


agents = [
    Agent(
        role=spec["role"],
        goal=spec["goal"],
        backstory=spec["backstory"],
        tools=[search, wiki][: spec.get("tool_count", 1)],
    )
    for spec in agent_specs
]


tasks = [
    Task(description=f"Task {i}", agent=agents[i])
    for i in range(len(agents))
]

crew = Crew(agents=agents, tasks=tasks, verbose=2)
