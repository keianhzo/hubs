const INFO_INIT_FAILED = "Failed to initialize avatar-audio-source.";
const INFO_NO_NETWORKED_EL = "Could not find networked el.";
const INFO_NO_OWNER = "Networked component has no owner.";

// Chrome seems to require a MediaStream be attached to an AudioElement before AudioNodes work correctly
// We don't want to do this in other browsers, particularly in Safari, which actually plays the audio despite
// setting the volume to 0.
const SHOULD_CREATE_SILENT_AUDIO_ELS = /chrome/i.test(navigator.userAgent);
function createSilentAudioEl(stream) {
  const audioEl = new Audio();
  audioEl.setAttribute("autoplay", "autoplay");
  audioEl.setAttribute("playsinline", "playsinline");
  audioEl.srcObject = stream;
  audioEl.volume = 0; // we don't actually want to hear audio from this element
  return audioEl;
}

async function getOwnerId(el, local = false) {
  if (local) {
    return NAF.connection.adapter.getClientId();
  } else {
    const networkedEl = await NAF.utils.getNetworkedEntity(el).catch(e => {
      console.error(INFO_INIT_FAILED, INFO_NO_NETWORKED_EL, e);
    });
    if (!networkedEl) {
      return null;
    }
    return networkedEl.components.networked.data.owner;
  }
}

async function getMediaStream(el, local = false) {
  const peerId = await getOwnerId(el, local);
  if (!peerId) {
    console.error(INFO_INIT_FAILED, INFO_NO_OWNER);
    return null;
  }
  const stream = await NAF.connection.adapter.getMediaStream(peerId).catch(e => {
    console.error(INFO_INIT_FAILED, `Error getting media stream for ${peerId}`, e);
  });
  if (!stream) {
    return null;
  }
  return stream;
}

function setPositionalAudioProperties(audio, settings) {
  audio.setDistanceModel(settings.distanceModel);
  audio.setMaxDistance(settings.maxDistance);
  audio.setRefDistance(settings.refDistance);
  audio.setRolloffFactor(settings.rolloffFactor);
}

AFRAME.registerComponent("avatar-audio-source", {
  schema: {
    positional: { default: true },
    distanceModel: {
      default: "inverse",
      oneOf: ["linear", "inverse", "exponential"]
    },
    maxDistance: { default: 10000 },
    refDistance: { default: 1 },
    rolloffFactor: { default: 1 },
    local: { default: false }
  },

  createAudio: async function() {
    this.isCreatingAudio = true;
    const stream = await getMediaStream(this.el, this.data.local);
    this.isCreatingAudio = false;
    const isRemoved = !this.el.parentNode;
    if (!stream || isRemoved) return;

    const audioListener = this.el.sceneEl.audioListener;
    const audio = this.data.positional ? new THREE.PositionalAudio(audioListener) : new THREE.Audio(audioListener);
    if (this.data.positional) {
      setPositionalAudioProperties(audio, this.data);
    }

    if (SHOULD_CREATE_SILENT_AUDIO_ELS) {
      createSilentAudioEl(stream); // TODO: Do the audio els need to get cleaned up?
    }

    const mediaStreamSource = audio.context.createMediaStreamSource(stream);
    audio.setNodeSource(mediaStreamSource);
    this.el.setObject3D(this.attrName, audio);
    this.el.emit("sound-source-set", { soundSource: mediaStreamSource });
  },

  destroyAudio() {
    const audio = this.el.getObject3D(this.attrName);
    if (!audio) return;

    audio.disconnect();
    this.el.removeObject3D(this.attrName);
  },

  init() {
    this.el.sceneEl.systems["hubs-systems"].audioSettingsSystem.registerAvatarAudioSource(this);
    // We subscribe to audio stream notifications for this peer to update the audio source
    // This could happen in case there is an ICE failure that requires a transport recreation.
    getOwnerId(this.el, this.data.local).then(peerId => {
      NAF.connection.adapter.addEventListener(peerId, "audio", this);
    });
    this.createAudio();
  },

  async onStreamUpdated(peerId, kind) {
    if (kind === "audio") {
      // The audio stream for this peer has been updated
      const stream = await NAF.connection.adapter.getMediaStream(peerId, "audio").catch(e => {
        console.error(INFO_INIT_FAILED, `Error getting media stream for ${peerId}`, e);
      });
      const audioListener = this.el.sceneEl.audioListener;
      const audio = this.data.positional ? new THREE.PositionalAudio(audioListener) : new THREE.Audio(audioListener);
      const mediaStreamSource = audio.context.createMediaStreamSource(stream);
      audio.setNodeSource(mediaStreamSource);
      this.el.emit("sound-source-set", { soundSource: mediaStreamSource });
    }
  },

  update(oldData) {
    if (this.isCreatingAudio) return;

    const audio = this.el.getObject3D(this.attrName);
    if (!audio) return;

    const shouldRecreateAudio = oldData.positional !== this.data.positional;
    if (shouldRecreateAudio) {
      this.destroyAudio();
      this.createAudio();
    } else if (this.data.positional) {
      setPositionalAudioProperties(audio, this.data);
    }
  },

  remove: function() {
    this.el.sceneEl.systems["hubs-systems"].audioSettingsSystem.unregisterAvatarAudioSource(this);
    getOwnerId(this.el, this.data.local).then(peerId => {
      NAF.connection.adapter.removeEventListener(peerId);
    });
    this.destroyAudio();
  }
});
