from pathlib import Path


# Copy this file to local_config.py and fill in paths for your own machine.
# local_config.py is ignored by Git and should not be committed.

# Used by the admin validation panel to compare submitted results against
# the original 3DLPD dataset. Leave it pointing to an empty/nonexistent local
# directory if you do not need that validation.
REFERENCE_DATASET_ROOT = Path(r"D:\path\to\3DLPD")
