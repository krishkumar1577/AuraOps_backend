from typing import TypedDict
from langgraph.graph import StateGraph, END


class AgentState(TypedDict):
    input: str
    output: str


def process(state: AgentState) -> AgentState:
    return {"input": state["input"], "output": f"echo: {state['input']}"}


graph = StateGraph(AgentState)
graph.add_node("process", process)
graph.set_entry_point("process")
graph.add_edge("process", END)
app = graph.compile()
