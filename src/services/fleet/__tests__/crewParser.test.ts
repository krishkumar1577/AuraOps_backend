import { CrewParser } from '../crewParser';

describe('CrewParser', () => {
  const parser = new CrewParser();

  const validCrewYaml = `
name: research-crew
agents:
  - name: researcher
    role: Research Analyst
    goal: Find accurate information
  - name: writer
    role: Content Writer
tasks:
  - description: Research the topic
    agent: researcher
  - description: Write the report
    agent: writer
`;

  it('should parse valid crew.yaml with name, agents, and tasks', () => {
    const crew = parser.parseContent(validCrewYaml);

    expect(crew.name).toBe('research-crew');
    expect(crew.agents).toHaveLength(2);
    expect(crew.agents[0].name).toBe('researcher');
    expect(crew.agents[0].role).toBe('Research Analyst');
    expect(crew.tasks).toHaveLength(2);
    expect(crew.tasks[0].agent).toBe('researcher');
  });

  it('should reject crew.yaml missing agents', () => {
    const invalidYaml = `
name: empty-crew
agents: []
tasks:
  - description: Do something
    agent: nobody
`;

    expect(() => parser.parseContent(invalidYaml)).toThrow('Invalid crew.yaml format');
  });

  it('should reject crew.yaml with missing name', () => {
    const invalidYaml = `
agents:
  - name: solo
tasks:
  - description: Solo task
    agent: solo
`;

    expect(() => parser.parseContent(invalidYaml)).toThrow('Invalid crew.yaml format');
  });
});
