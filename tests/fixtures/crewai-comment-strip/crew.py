"""
Comment-strip fixture: verifies the detector does NOT match
`Agent()` occurrences inside comments, docstrings, or strings.

The detector must:
  - Match `Agent(` in real constructor calls
  - NOT match `Agent(` inside a `#` comment
  - NOT match `Agent(` inside a docstring
  - NOT match the string "Agent()" inside another string
  - Match `from crewai import Agent` as the framework-import signal
"""

from crewai import Agent, Crew, Task

# This comment mentions Agent() to test that the detector ignores it.
# Agent() is used here on purpose.
# agent_count_marker_2 = 2

def helper():
    """
    This docstring references Agent(role="X") to make sure we don't
    count it as a real agent definition.
    Agent(  # another decoy
        role="Decoy",
    )
    """
    pass


NOT_AN_AGENT = "Agent(role='quoted-string-decoy')"


real_researcher = Agent(
    role="Researcher",
    goal="Find sources",
    backstory="Researcher",
    tools=[],
)

real_writer = Agent(
    role="Writer",
    goal="Write the report",
    backstory="Writer",
    tools=[],
)

t1 = Task(description="Do the thing", agent=real_researcher)
t2 = Task(description="Write it up", agent=real_writer)

crew = Crew(agents=[real_researcher, real_writer], tasks=[t1, t2], verbose=2)
