import React, { Component } from 'react'
import PropTypes from 'prop-types'
import { TextField } from '@material-ui/core'
import { withStyles } from '@material-ui/core/styles'
import ThreadReply from './thread-reply'

const styles = theme => ({
  wrapper: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
  },
  title: {
    textAlign: 'center',
    padding: theme.spacing.unit * 2,
    borderBottom: `1px solid ${theme.palette.grey[300]}`,
  },
  input: {
    width: '100%',
  },
})

class ThreadNew extends Component {
  state = {
    title: '',
  }

  handleTitleChange = evt => {
    this.setState({ title: evt.target.value })
  }

  render() {
    const { classes, savingStatus } = this.props
    const { title } = this.state

    return (
      <div className={classes.wrapper}>
        <div className={classes.title}>
          <TextField
            className={classes.input}
            value={title}
            label='Title'
            variant='outlined'
            onChange={this.handleTitleChange}
          />
        </div>
        <div style={{ flex: 1 }}></div>
        <ThreadReply
          title={title}
          savingStatus={savingStatus}
          onSend={this.props.onSend}
        />
      </div>
    )
  }
}

ThreadNew.propTypes = {
  classes: PropTypes.object,
  savingStatus: PropTypes.string,
  onSend: PropTypes.func,
}

export default withStyles(styles)(ThreadNew)
