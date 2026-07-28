/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { Flex } from "@components/Flex";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { type Channel, FluxStore, type GuildMember, type RenderModalProps, type User, type UsernameUtils } from "@vencord/discord-types";
import { findStore, waitFor } from "@webpack";
import {
    FluxDispatcher,
    GuildMemberStore,
    Menu,
    MessageStore,
    Modal,
    openModal,
    RelationshipStore,
    TextInput,
    UserStore,
    useState,
} from "@webpack/common";

const logger = new Logger("EditUsers");
const unpatches: Array<() => void> = [];
const userCache = new WeakMap<User, { name: string; user: User }>();
const memberCache = new WeakMap<GuildMember, { member: GuildMember; name: string }>();

interface ChannelMemberUpdate {
    type: "GUILD_MEMBER_UPDATE";
    guildId: string;
    user: User;
}

interface DispatcherActionHandler {
    actionHandler(event: ChannelMemberUpdate): boolean | void;
    name: string;
}

interface ChannelMemberStore extends FluxStore { }

type Dispatcher = {
    _actionHandlers: {
        getOrderedActionHandlers(event: ChannelMemberUpdate): DispatcherActionHandler[];
    };
};

let originalGetUser: ((userId: string) => User) | undefined;
let channelMemberStore: ChannelMemberStore | undefined;
let patchInstance = 0;

const settings = definePluginSettings({
    users: {
        type: OptionType.CUSTOM,
        default: {} as Record<string, string>,
    },
});

export function getLocalName(userId: string) {
    return settings.store.users[userId]?.trim();
}

function getOriginalDisplayName(userId: string, fallback?: string) {
    const user = originalGetUser?.(userId);
    return user?.globalName ?? user?.username ?? fallback;
}

function formatLocalName(userId: string, originalName: string | undefined) {
    const localName = getLocalName(userId);
    if (!localName) return undefined;

    let trimmedOriginalName = originalName?.trim();
    const localPrefix = `${localName} (`;

    // sometimes this gets called recursively, this keeps it idempotent
    while (trimmedOriginalName?.startsWith(localPrefix) && trimmedOriginalName.endsWith(")")) {
        trimmedOriginalName = trimmedOriginalName.slice(localPrefix.length, -1).trim();
    }

    if (!trimmedOriginalName
        || trimmedOriginalName.toLocaleLowerCase() === localName.toLocaleLowerCase()) {
        return localName;
    }

    return `${localName} (${trimmedOriginalName})`;
}

function setLocalName(userId: string, name: string) {
    const trimmedName = name.trim();

    if (trimmedName) {
        settings.store.users[userId] = trimmedName;
    } else {
        delete settings.store.users[userId];
    }

    refreshNames(userId);
}

function rebuildChannelMember(userId: string) {
    const user = originalGetUser?.(userId);
    if (!user) return;

    // Discord's handler rebuilds its denormalized row from GuildMemberStore.getMember.
    // Invoke only that store's handler so the event cannot mutate the underlying member.
    const handler = (FluxDispatcher as Dispatcher)._actionHandlers
        .getOrderedActionHandlers({ type: "GUILD_MEMBER_UPDATE", guildId: "", user })
        .find(handler => handler.name === "ChannelMemberStore");
    if (!handler) return;

    for (const guildId of GuildMemberStore.memberOf(userId)) {
        handler.actionHandler({ type: "GUILD_MEMBER_UPDATE", guildId, user });
    }

    channelMemberStore?.emitChange();
}

function refreshNames(userId?: string) {
    if (userId) rebuildChannelMember(userId);
    UserStore.emitChange();
    GuildMemberStore.emitChange();
    RelationshipStore.emitChange();
    MessageStore.emitChange();
}

function withLocalUser(user: User) {
    // the type is wrong so this can be undefined...
    if (!user) return user;

    const originalName = getOriginalDisplayName(
        user.id,
        user.globalName ?? user.username,
    );
    const name = formatLocalName(user.id, originalName);
    if (!name) return user;

    const cached = userCache.get(user);
    if (cached?.name === name) return cached.user;

    const localUser = user.set("globalName", name);

    userCache.set(user, { name, user: localUser });
    return localUser;
}

function withLocalMember(member: GuildMember): GuildMember;
function withLocalMember(member: GuildMember | null): GuildMember | null;
function withLocalMember(member: GuildMember | null): GuildMember | null {
    if (!member) return null;

    const originalName = member.nick || getOriginalDisplayName(member.userId);

    const name = formatLocalName(member.userId, originalName);
    if (!name) return member;

    const cached = memberCache.get(member);
    if (cached?.name === name) return cached.member;

    const localMember = { ...member, nick: name };

    memberCache.set(member, { member: localMember, name });
    return localMember;
}

type AnyFunction = (...args: any[]) => any;

type FunctionKeys<T> = {
    [K in keyof T]-?: T[K] extends AnyFunction ? K : never;
}[keyof T];

type FunctionAt<T, K extends FunctionKeys<T>> = Extract<T[K], AnyFunction>;

function patchAfter<T extends object, K extends FunctionKeys<T>, Fn extends FunctionAt<T, K>>(
    target: T,
    key: K,
    transform: (result: ReturnType<Fn>, args: Parameters<Fn>) => ReturnType<Fn>,
    mapArgs?: (args: Parameters<Fn>) => Parameters<Fn>,
) {
    const original = target[key] as Fn;
    const patched = function (this: T, ...args: Parameters<Fn>): ReturnType<Fn> {
        const originalArgs = mapArgs?.(args) ?? args;
        return transform(original.apply(this, originalArgs), args);
    };

    const ownDescriptor = Object.getOwnPropertyDescriptor(target, key);

    target[key] = patched as any;

    unpatches.push(() => {
        if (target[key] !== patched) return;

        if (ownDescriptor) {
            Object.defineProperty(target, key, ownDescriptor);
        } else {
            delete target[key];
        }
    });
}

function patchNameResolvers() {
    const generation = ++patchInstance;
    originalGetUser = UserStore.getUser.bind(UserStore);
    channelMemberStore = findStore("ChannelMemberStore") as ChannelMemberStore;

    patchAfter(UserStore, "getUser", withLocalUser);
    patchAfter(UserStore, "getCurrentUser", withLocalUser);

    patchAfter(GuildMemberStore, "getMember", withLocalMember);
    patchAfter(GuildMemberStore, "getTrueMember", withLocalMember);

    patchAfter(RelationshipStore, "getNickname", (nick, [userId]) => formatLocalName(userId, nick || getOriginalDisplayName(userId)) ?? nick);

    for (const userId of Object.keys(settings.store.users)) {
        rebuildChannelMember(userId);
    }

    waitFor(["useName", "getGlobalName"], (usernameUtils: UsernameUtils) => {
        if (generation !== patchInstance) return;

        const toOverride = [
            "getGlobalName",
            "getName",
            "getUserTag",
        ] as const;

        for (const method of toOverride) {
            patchAfter(
                usernameUtils,
                method,
                (name, args) => formatLocalName(args[0]?.id, name) ?? name,
                args => {
                    const user = args[0];
                    const originalUser = user && originalGetUser?.(user.id);
                    if (!originalUser) return args;

                    return [originalUser, ...args.slice(1)] as typeof args;
                },
            );
        }
    });
}

function removePatches() {
    patchInstance++;
    const userIds = Object.keys(settings.store.users);

    for (const unpatch of unpatches.splice(0).reverse()) {
        try {
            unpatch();
        } catch (error) {
            logger.warn("Could not restore a name resolver", error);
        }
    }

    for (const userId of userIds) {
        rebuildChannelMember(userId);
    }

    originalGetUser = undefined;
    refreshNames();
}

function LocalNameModal({ modalProps, user }: { modalProps: RenderModalProps; user: User; }) {
    const currentName = getLocalName(user.id) ?? "";
    const [name, setName] = useState(currentName);

    const originalUser = originalGetUser?.(user.id) ?? user;
    const originalName = originalUser.globalName || originalUser.username;

    function save() {
        setLocalName(user.id, name);
        modalProps.onClose();
    }

    return (
        <Modal
            {...modalProps}
            title="Set Local Name"
            subtitle={`Only you will see this name for ${originalName}.`}
            actions={[
                {
                    text: "Cancel",
                    variant: "secondary",
                    onClick: modalProps.onClose,
                },
                ...(currentName
                    ? [
                        {
                            text: "Reset",
                            variant: "secondary" as const,
                            onClick: () => {
                                setLocalName(user.id, "");
                                modalProps.onClose();
                            },
                        },
                    ]
                    : []),
                {
                    text: "Save",
                    variant: "primary",
                    onClick: save,
                    disabled: !name.trim(),
                },
            ]}
        >
            <Flex flexDirection="column" gap={8}>
                <Heading>Name</Heading>
                <TextInput
                    autoFocus
                    maxLength={32}
                    placeholder={originalName}
                    value={name}
                    onChange={setName}
                    onKeyDown={event => {
                        if (event.key === "Enter") {
                            event.preventDefault();
                            if (name.trim()) save();
                        }
                    }}
                />
                <Paragraph>
                    This changes the name locally throughout Discord. It does not rename the
                    account or change server nicknames for anyone else.
                </Paragraph>
            </Flex>
        </Modal>
    );
}

interface UserContextProps {
    channel?: Channel;
    user?: User;
}

const userContextMenuPatch: NavContextMenuPatchCallback = (children, props: UserContextProps) => {
    const recipientId = props.channel?.isDM() ? props.channel.getRecipientId() : undefined;
    const user = props.user ?? (recipientId ? UserStore.getUser(recipientId) : undefined);
    if (!user) return;

    children.splice(
        -1,
        0,
        <Menu.MenuGroup>
            <Menu.MenuItem
                id="vc-edit-user-name"
                label={
                    getLocalName(user.id)
                        ? "Edit Local Name"
                        : "Set Local Name"
                }
                action={() => openModal(modalProps => <LocalNameModal modalProps={modalProps} user={user} />)}
            />
        </Menu.MenuGroup>,
    );
};

export default definePlugin({
    name: "EditUsers",
    description: "Lets you assign local names to Discord users",
    tags: ["Appearance", "Customisation", "Friends"],
    authors: [Devs.wthueb],
    settings,

    contextMenus: {
        "user-context": userContextMenuPatch,
        "user-profile-actions": userContextMenuPatch,
        "user-profile-overflow-menu": userContextMenuPatch,
    },

    start: patchNameResolvers,
    stop: removePatches,
});
