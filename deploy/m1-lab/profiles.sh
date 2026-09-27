# Model profiles for the M1 lab server. Sourced by m1-lab.sh (this Mac) and remote.sh (the M1).
# Plain bash 3.2: the M1 runs stock macOS bash.
#
# Each profile pins an exact GGUF (size + sha256 from the Hugging Face tree API) so the M1 can
# verify a download without python or jq.

M1_LAB_DEFAULT_PROFILE="qwen38-27b"
M1_LAB_PROFILES="qwen38-27b qwen38-27b-mtp qwen36-35b-a3b test-4b test-08b"

profile_load() {
	PROFILE_CTX=131072
	PROFILE_MAX_TOKENS=32768
	PROFILE_EXTRA_ARGS=""
	case "$1" in
	qwen38-27b)
		PROFILE_REPO="huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF"
		PROFILE_FILE="Huihui-Qwen3.8-27B-abliterated-UD-Q4_K_XL.gguf"
		PROFILE_SIZE=17378626464
		PROFILE_SHA256="ebbc66b45cf36bf47dc052d560337ff047a8b4eef851c8919d83d623703b6aa4"
		PROFILE_ALIAS="qwen3.8-27b-abliterated"
		PROFILE_NAME="Qwen3.8-27B abliterated (M1 lab, Q4_K_XL)"
		;;
	qwen38-27b-mtp)
		# Smaller quant that ships the MTP head, for llama.cpp's MTP speculative decoding.
		# Untested on the M1: benchmark against qwen38-27b before switching to it.
		PROFILE_REPO="huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF"
		PROFILE_FILE="Huihui-Qwen3.8-27B-abliterated-GSQ-RCO-IQ3_S-mtp.gguf"
		PROFILE_SIZE=12120016416
		PROFILE_SHA256="eea0638e283433e27b0edbd409b552be467a75ecc777d91c51db554c0a644c19"
		PROFILE_ALIAS="qwen3.8-27b-abliterated-mtp"
		PROFILE_NAME="Qwen3.8-27B abliterated (M1 lab, IQ3_S + MTP)"
		PROFILE_EXTRA_ARGS="--spec-type draft-mtp"
		;;
	qwen36-35b-a3b)
		# MoE with 3B active parameters: several times faster than the dense 27B on M1.
		PROFILE_REPO="huihui-ai/Huihui-Qwen3.6-35B-A3B-abliterated-MTP-GGUF"
		PROFILE_FILE="Huihui-Qwen3.6-35B-A3B-abliterated-ggml-model-Q4_K.gguf"
		PROFILE_SIZE=21712409824
		PROFILE_SHA256="63b75afb4b68fc61059c78115b580037074de88146e0762f4a496081e410cf81"
		PROFILE_ALIAS="qwen3.6-35b-a3b-abliterated"
		PROFILE_NAME="Qwen3.6-35B-A3B abliterated (M1 lab, Q4_K)"
		;;
	test-4b)
		# Same qwen3_5 architecture as Qwen3.8, 2.7 GB. Used to rehearse the whole flow.
		PROFILE_REPO="unsloth/Qwen3.5-4B-GGUF"
		PROFILE_FILE="Qwen3.5-4B-Q4_K_M.gguf"
		PROFILE_SIZE=2740937888
		PROFILE_SHA256="00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4"
		PROFILE_ALIAS="qwen3.5-4b-test"
		PROFILE_NAME="Qwen3.5-4B (M1 lab rehearsal model)"
		PROFILE_CTX=65536
		PROFILE_MAX_TOKENS=16384
		;;
	test-08b)
		# Smallest qwen3_5 build (0.5 GB): checks the plumbing on a slow link, not model quality.
		PROFILE_REPO="unsloth/Qwen3.5-0.8B-GGUF"
		PROFILE_FILE="Qwen3.5-0.8B-Q4_K_M.gguf"
		PROFILE_SIZE=532517120
		PROFILE_SHA256="bd258782e35f7f458f8aced1adc053e6e92e89bc735ba3be89d38a06121dc517"
		PROFILE_ALIAS="qwen3.5-0.8b-test"
		PROFILE_NAME="Qwen3.5-0.8B (M1 lab plumbing check)"
		PROFILE_CTX=65536
		PROFILE_MAX_TOKENS=8192
		;;
	*)
		echo "unknown profile: $1 (known: $M1_LAB_PROFILES)" >&2
		return 1
		;;
	esac
	PROFILE_URL="https://huggingface.co/$PROFILE_REPO/resolve/main/$PROFILE_FILE"
}
