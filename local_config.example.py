from pathlib import Path


# Copy this file to local_config.py and fill in paths for your own machine.
# local_config.py is ignored by Git and should not be committed.

# Used by the admin validation panel to compare submitted results against
# the original 3DLPD dataset. Leave it pointing to an empty/nonexistent local
# directory if you do not need that validation.
REFERENCE_DATASET_ROOT = Path(r"D:\path\to\3DLPD")

# Used by the admin page to locate each submitter's original input slice.
# This directory may contain split folders such as split_01_A, split_01_B, ...
ADMIN_INPUT_ROOT = Path(r"D:\path\to\3D_Datasets\task")
