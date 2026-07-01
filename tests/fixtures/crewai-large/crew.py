"""
Large CrewAI fixture: 12 agents, 30 tools total.
Hits the >12 warn boundary but stays just under it (12 agents = L4).
"""

from crewai import Agent, Crew, Task
from langchain_community.tools import (
    DuckDuckGoSearchRun,
    WikipediaQueryRun,
    ShellTool,
    ReadFileTool,
    WriteFileTool,
    ListDirectoryTool,
    MoveFileTool,
    CopyFileTool,
    DeleteFileTool,
    InternetSearchRun,
)


S = DuckDuckGoSearchRun()
W = WikipediaQueryRun()
SH = ShellTool()
R = ReadFileTool()
WR = WriteFileTool()
LD = ListDirectoryTool()
MV = MoveFileTool()
CP = CopyFileTool()
DL = DeleteFileTool()
IS = InternetSearchRun()

TOOLS_POOL = [S, W, SH, R, WR, LD, MV, CP, DL, IS]


def mk_agent(role: str, idx: int) -> Agent:
    return Agent(
        role=role,
        goal=f"Do {role} things",
        backstory=f"{role} #{idx}",
        tools=TOOLS_POOL[:3],
    )


agents = [mk_agent(name, i) for i, name in enumerate([
    "researcher", "analyst", "engineer", "reviewer", "writer",
    "planner", "tester", "designer", "operator", "auditor",
    "curator", "publisher",
])]

tasks = [
    Task(description=f"Task {i}", agent=agents[i])
    for i in range(len(agents))
]

crew = Crew(agents=agents, tasks=tasks, verbose=2)
