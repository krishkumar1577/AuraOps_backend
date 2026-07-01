"""
Stress CrewAI fixture: 15 agents, 30 tools total.
Crosses the >12 warn boundary. Verifies requiresHumanReview=true is set.
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


def mk_agent(role: str) -> Agent:
    return Agent(
        role=role,
        goal=f"Do {role} things",
        backstory=f"{role} on the team",
        tools=TOOLS_POOL[:2],
    )


ROLES = [
    "researcher", "analyst", "engineer", "reviewer", "writer",
    "planner", "tester", "designer", "operator", "auditor",
    "curator", "publisher", "editor", "translator", "summarizer",
]

agents = [mk_agent(r) for r in ROLES]
tasks = [Task(description=f"Task {i}", agent=agents[i]) for i in range(len(agents))]

crew = Crew(agents=agents, tasks=tasks, verbose=2)
