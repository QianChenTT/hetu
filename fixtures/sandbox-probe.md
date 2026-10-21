# Sandbox probe

Each probe tries every way out of its frame and saves the results into its own tag.

Default grants:

<Artifact src="./probe.artifact.html" name="probe-default" height="200" />

Asks to read the note:

<Artifact src="./probe.artifact.html" name="probe-read" grants="note.read" height="200" />

Asks to read the note and for network, which is not allowed together:

<Artifact src="./probe.artifact.html" name="probe-net" grants="note.read" network="example.com" height="200" />
