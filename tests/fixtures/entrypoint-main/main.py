"""Entry fixture: a project whose only Python file is main.py with a real __main__ block."""
from langchain.agents import AgentExecutor
from langchain.llms import OpenAI

def run():
    llm = OpenAI()
    return llm("hello")

if __name__ == "__main__":
    run()
