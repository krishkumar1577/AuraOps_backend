"""
Small CrewAI fixture: 2 agents, 3 tools total.
Used to verify detector picks smallest GPU tier (T4) and low tool count.
"""

from crewai import Agent, Crew, Task
from langchain_community.tools import DuckDuckGoSearchRun, WikipediaQueryRun
from langchain.agents import load_tools


# Tool 1
search_tool = DuckDuckGoSearchRun()

# Tool 2
wiki_tool = WikipediaQueryRun()

# Tool 3 (loaded via helper)
extra_tools = load_tools(["requests_all"])


researcher = Agent(
    role="Researcher",
    goal="Find accurate sources",
    backstory="Expert at web research",
    tools=[search_tool, wiki_tool],
    verbose=True,
)

writer = Agent(
    role="Writer",
    goal="Write clear summaries",
    backstory="Technical writer",
    tools=extra_tools,
    verbose=True,
)

research_task = Task(
    description="Research the topic",
    agent=researcher,
)

write_task = Task(
    description="Write the report",
    agent=writer,
)

crew = Crew(
    agents=[researcher, writer],
    tasks=[research_task, write_task],
    verbose=2,
)
