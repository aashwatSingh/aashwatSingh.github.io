import os

# Tests run against the fictional fixture profile only, never against the candidate's shared answers.
os.environ["INTERNSHIP_AGENT_NO_SHARED"] = "1"
