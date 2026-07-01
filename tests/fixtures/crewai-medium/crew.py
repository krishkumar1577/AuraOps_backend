"""
Medium CrewAI fixture: 5 agents, 10 tools total.
Used for the cold-start baseline measurement and the T4-vs-L4 boundary.
"""

from crewai import Agent, Crew, Task
from langchain_community.tools import (
    DuckDuckGoSearchRun,
    WikipediaQueryRun,
    ShellTool,
    ReadFileTool,
    WriteFileTool,
)


search = DuckDuckGoSearchRun()
wiki = WikipediaQueryRun()
shell = ShellTool()
reader = ReadFileTool()
writer = WriteFileTool()


researcher = Agent(
    role="Researcher",
    goal="Gather facts",
    backstory="Senior researcher",
    tools=[search, wiki],
)

analyst = Agent(
    role="Analyst",
    goal="Analyze findings",
    backstory="Data analyst",
    tools=[shell, reader],
)

engineer = Agent(
    role="Engineer",
    goal="Build the solution",
    backstory="Software engineer",
    tools=[shell, writer],
)

reviewer = Agent(
    role="Reviewer",
    goal="Review for correctness",
    backstory="QA lead",
    tools=[reader],
)

writer = Agent(
    role="Writer",
    goal="Write the final report",
    backstory="Technical writer",
    tools=[wiki, WriteFileTool()],
)

t1 = Task(description="Research", agent=researcher)
t2 = Task(description="Analyze", agent=analyst)
t3 = Task(description="Build", agent=engineer)
t4 = Task(description="Review", agent=reviewer)
t5 = Task(description="Write report", agent=writer)

crew = Crew(
    agents=[researcher, analyst, engineer, reviewer, writer],
    tasks=[t1, t2, t3, t4, t5],
    verbose=2,
)
