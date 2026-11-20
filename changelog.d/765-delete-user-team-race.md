- **Fixed: deleting a contestant while they change team no longer leaves a
  ghost team member (#765).** The membership removal and the record delete
  now run as one Redis script against the team the player's record names at
  that moment, not the team the delete read at the start. A player who joins
  or switches team mid-delete is removed from the team they ended up on. A
  player who became captain mid-delete is refused at that step, and the error
  says to transfer the captaincy and delete again. The account and progress
  are already gone at that point, and the re-run finishes the delete.
