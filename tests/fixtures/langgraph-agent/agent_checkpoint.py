from typing import TypedDict
from langgraph.graph import StateGraph, END
from langgraph.checkpoint.sqlite import SqliteSaver


class AgentState(TypedDict):
    input: str
    output: str


def process(state: AgentState) -> AgentState:
    return {"input": state["input"], "output": f"checkpointed: {state['input']}"}


graph = StateGraph(AgentState)
graph.add_node("process", process)
graph.set_entry_point("process")
graph.add_edge("process", END)

checkpointer = SqliteSaver.from_conn_string(":memory:")
app = graph.compile(checkpointer=checkpointer)
